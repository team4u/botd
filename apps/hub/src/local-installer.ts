/**
 * Hub 本地资源安装器：零外部节点也能把 Skill / Extension 装进 Hub 权威存储。
 *
 * 支持三类来源：
 * - 本地文件（`.md` → Skill；`.ts`/`.js` → Extension）与本地目录（`SKILL.md` → Skill）；
 * - Git 仓库（含 `owner/repo`、`owner/repo#branch`、`.../tree/branch/subdir` 约定，浅克隆到临时目录）；
 * - npm 包（`npm:<spec>`，装进临时目录后取入口文件 / 生成 shim）。
 *
 * 与节点侧 installer 不同，这里不落 dataDir 目录树，而是直接解析出
 * `{ kind, id, content }`：content 即 Hub SQLite（hub_skills / hub_extensions）要存的
 * 权威内容，调用方 saveSkillContent / saveExtensionContent 即完成安装。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LocalInstallInput {
  source: string;
  kind?: 'auto' | 'skill' | 'extension';
  customId?: string;
}

export interface LocalInstallResult {
  kind: 'skill' | 'extension';
  id: string;
  content: string;
}

export function sanitizeInstallId(input: string): string {
  const sanitized = input
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!sanitized) throw new Error(`Invalid identifier: "${input}"`);
  return sanitized;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

const isHttpSource = (source: string): boolean =>
  source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@');

/** 是否为 Hub 可自行解析的来源（本地路径 / git / npm）；纯 http(s) 非 git 地址不算。 */
export function isLocallyInstallable(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('npm:')) return true;
  if (isHttpSource(trimmed)) return true; // git URL / github tree 链接
  // 本地路径：存在即真（stat 留给安装时做，这里做保守前缀判断交给调用方 try）
  return !trimmed.includes('://') || trimmed.startsWith('file://');
}

/** 解析 git 来源：github tree 链接 / `owner/repo` 简写 / 完整 git URL。 */
function parseGitSource(source: string): { repoUrl: string; branch?: string; subPath?: string; inferredName: string } {
  const treeMatch = source.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/);
  if (treeMatch) {
    const [, owner, repo, branch, subPath] = treeMatch;
    const cleanRepo = repo.replace(/\.git$/, '');
    const segments = (subPath ?? '').split('/').filter(Boolean);
    return {
      repoUrl: `https://github.com/${owner}/${cleanRepo}.git`,
      branch,
      subPath,
      inferredName: segments.length > 0 ? segments[segments.length - 1] : cleanRepo,
    };
  }
  const shorthand = source.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (shorthand && shorthand[1] !== '.' && shorthand[1] !== '..' && !source.includes(':')) {
    return { repoUrl: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`, inferredName: shorthand[2] };
  }
  const nameMatch = source.match(/([^/:]+?)(?:\.git)?$/);
  return { repoUrl: source.replace(/\.git$/, '') + (source.endsWith('.git') ? '' : ''), inferredName: nameMatch ? nameMatch[1] : 'resource' };
}

/** Skill 目录的权威内容：根 SKILL.md；退化取目录内首个 .md。 */
async function skillContentOf(dir: string): Promise<string | undefined> {
  const rootSkill = path.join(dir, 'SKILL.md');
  if (await fileExists(rootSkill)) return fs.readFile(rootSkill, 'utf8');
  const entries = await fs.readdir(dir).catch(() => []);
  const md = entries.find((name) => name.toLowerCase() === 'skill.md') ?? entries.find((name) => name.endsWith('.md'));
  if (md === undefined) return undefined;
  return fs.readFile(path.join(dir, md), 'utf8');
}

/** Extension 目录的权威内容：根 index.ts（或唯一 .ts/.js 入口）；带 package.json 的目录生成 shim。 */
async function extensionContentOf(dir: string): Promise<string | undefined> {
  const indexTs = path.join(dir, 'index.ts');
  if (await fileExists(indexTs)) return fs.readFile(indexTs, 'utf8');
  const indexMjs = path.join(dir, 'index.mjs');
  if (await fileExists(indexMjs)) return fs.readFile(indexMjs, 'utf8');
  const pkgPath = path.join(dir, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { name?: string };
      const name = typeof pkg.name === 'string' && pkg.name ? pkg.name : 'resource';
      return `import ext from '${name}';\nexport default ext;\n`;
    } catch {
      // 非法 package.json：继续找 .ts 入口
    }
  }
  const entries = await fs.readdir(dir).catch(() => []);
  const tsEntries = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts'));
  if (tsEntries.length === 1) return fs.readFile(path.join(dir, tsEntries[0]), 'utf8');
  return undefined;
}

/** 从（本地或克隆的）目录解析安装结果；解析不出内容时抛错。 */
async function resolveFromDir(
  dir: string,
  input: LocalInstallInput,
  nameHint: string,
): Promise<LocalInstallResult> {
  const hasSkillMd = await fileExists(path.join(dir, 'SKILL.md'));
  const kind: 'skill' | 'extension' =
    input.kind && input.kind !== 'auto' ? input.kind : hasSkillMd ? 'skill' : 'extension';
  const id = sanitizeInstallId(input.customId || nameHint || path.basename(dir));
  const content = kind === 'skill' ? await skillContentOf(dir) : await extensionContentOf(dir);
  if (content === undefined || !content.trim()) {
    throw new Error(`No usable ${kind === 'skill' ? 'SKILL.md' : 'entry file (.ts/index.ts)'} found in "${input.source}"`);
  }
  return { kind, id, content };
}

/** npm: 包规范：装进临时目录，取包内入口生成 shim（对齐节点侧 installer 行为）。 */
async function installNpm(pkgSpec: string, input: LocalInstallInput): Promise<LocalInstallResult> {
  const pkgNameMatch = pkgSpec.match(/^(@[^/@]+\/[^/@]+|[^/@]+)/);
  const pkgName = pkgNameMatch ? pkgNameMatch[1] : pkgSpec;
  const id = sanitizeInstallId(input.customId || pkgName.replace(/^@[^/]+\//, ''));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-hub-install-'));
  try {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: `botd-ext-${id}`, private: true }, null, 2),
      'utf8',
    );
    await execFileAsync('npm', ['install', pkgSpec, '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: tempDir,
      windowsHide: true,
    });
    const installedDir = path.join(tempDir, 'node_modules', pkgName);
    // Pi Package 兼容：包 manifest 带 pi.extensions 时优先用其首个扩展入口。
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(installedDir, 'package.json'), 'utf8')) as {
        pi?: { extensions?: string[] };
      };
      const rel = pkg.pi?.extensions?.[0];
      if (rel) {
        const content = await fs.readFile(path.join(installedDir, rel.replace(/^\.\//, '')), 'utf8');
        return { kind: 'extension', id, content };
      }
    } catch {
      // 无 manifest 或读取失败：退回 shim
    }
    return { kind: 'extension', id, content: `import ext from '${pkgName}';\nexport default ext;\n` };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 在 Hub 本地解析并安装资源（不依赖任何外部节点）。
 * 成功返回 `{ kind, id, content }`；来源无法本地解析时抛错（调用方决定是否回退节点）。
 */
export async function installResourceLocally(input: LocalInstallInput): Promise<LocalInstallResult> {
  const source = input.source.trim();
  if (!source) throw new Error('Install source cannot be empty');

  // (1) npm 包
  if (source.startsWith('npm:')) {
    const pkgSpec = source.slice(4).trim();
    if (!pkgSpec) throw new Error('NPM package specification cannot be empty');
    return installNpm(pkgSpec, input);
  }

  // (2) 本地文件 / 目录
  if (!isHttpSource(source)) {
    const localPath = source.startsWith('file://') ? new URL(source).pathname : source;
    const stat = await fs.stat(localPath).catch(() => null);
    if (stat?.isFile()) {
      const ext = path.extname(localPath);
      const baseId = sanitizeInstallId(input.customId || path.basename(localPath, ext));
      const kind: 'skill' | 'extension' =
        input.kind && input.kind !== 'auto' ? input.kind : source.endsWith('.md') ? 'skill' : 'extension';
      const content = await fs.readFile(localPath, 'utf8');
      if (!content.trim()) throw new Error(`"${source}" is empty`);
      return { kind, id: baseId, content };
    }
    if (stat?.isDirectory()) {
      return resolveFromDir(localPath, input, path.basename(localPath));
    }
    // 既不是存在的本地路径、也不是 git URL 简写时才继续到 (3)；
    // owner/repo 简写会命中 (3)，其余无法解析的来源直接报错。
    if (!/^[\w.-]+\/[\w.-]+$/.test(source)) {
      throw new Error(`Install source not found locally and not a git/npm reference: "${source}"`);
    }
  }

  // (3) Git 仓库（浅克隆到临时目录，解析后即清理）
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-hub-git-'));
  try {
    const { repoUrl, branch, subPath, inferredName } = parseGitSource(source);
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(repoUrl, tempDir);
    await execFileAsync('git', cloneArgs, { cwd: os.tmpdir(), windowsHide: true });
    await fs.rm(path.join(tempDir, '.git'), { recursive: true, force: true }).catch(() => undefined);
    const root = subPath ? path.join(tempDir, subPath) : tempDir;
    if (!(await fileExists(root))) throw new Error(`Subpath "${subPath}" not found in repository`);
    // 根部无 SKILL.md 时尝试标准嵌套布局（skills/<name> 等），取唯一技能目录。
    if (!(await fileExists(path.join(root, 'SKILL.md')))) {
      for (const nestedRoot of ['skills', path.join('.agents', 'skills'), path.join('.agent', 'skills')]) {
        const nestedDir = path.join(root, nestedRoot);
        const entries = await fs.readdir(nestedDir).catch(() => []);
        const skillDirs: string[] = [];
        for (const name of entries) {
          if (await fileExists(path.join(nestedDir, name, 'SKILL.md'))) skillDirs.push(name);
        }
        if (skillDirs.length > 0) {
          const pick = input.customId && skillDirs.includes(input.customId) ? input.customId : skillDirs[0];
          return resolveFromDir(path.join(nestedDir, pick), input, pick);
        }
      }
    }
    return resolveFromDir(root, input, inferredName);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
