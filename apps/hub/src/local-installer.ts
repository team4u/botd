/**
 * Hub 本地资源安装器：零外部节点也能把 Skill / Extension 装进 Hub 权威存储。
 *
 * 安装产物是完整、持久、可运行的包目录（ResourcePackage）：
 * - 保留 references / scripts / assets / package.json / 相对 import 等全部文件；
 * - 临时 staging 解析 → 校验通过后交给调用方落盘（落盘失败不破坏已装包）；
 * - npm 包把 node_modules 运行依赖随包复制，清理 staging 后扩展仍可执行；
 * - git/npm 尽量在 Hub 权威安装，依赖平台与 Hub 运行时一致。
 *
 * 支持的来源：本地文件 / 目录、file://、npm:<spec>（@scope/pkg、pkg@version）、
 * git URL（git:https://…、git:github.com/owner/repo@ref）、owner/repo、
 * owner/repo@skillName、GitHub tree 链接；嵌套布局 skills/<name>、
 * .agents/skills/<name>、.agent/skills/<name>。多候选技能不静默挑第一个：
 * 无显式选择（skillName / customId）且歧义时报错。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseGitSource } from './git-source.js';

const execFileAsync = promisify(execFile);

export interface LocalInstallInput {
  source: string;
  kind?: 'auto' | 'skill' | 'extension';
  customId?: string;
}

export interface LocalInstallResult {
  kind: 'skill' | 'extension';
  id: string;
  /** 包内全部文件（POSIX 相对路径 → 内容）；npm 依赖经 `npm/` 前缀随包。 */
  files: Record<string, string>;
  /** 入口文件相对路径。 */
  entry: string;
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

/** npm 安装到 staging 的依赖在包内的挂载前缀（落盘后位于 <pkg>/npm/node_modules/…）。 */
const BUNDLED_DEPS_PREFIX = 'npm/node_modules';

const isHttpSource = (source: string): boolean =>
  source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@');

/** 是否为 Hub 可自行解析的来源（本地路径 / git / npm）；纯 http(s) 非 git 地址不算。 */
export function isLocallyInstallable(source: string): boolean {
  const trimmed = source.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('npm:')) return true;
  if (isHttpSource(trimmed)) return true; // git URL / github tree 链接
  return !trimmed.includes('://') || trimmed.startsWith('file://');
}

/** `npm:<spec>` 规范拆解：`@scope/pkg@ver` / `pkg@ver` / 裸名。 */
function parseNpmSpec(pkgSpec: string): { name: string; version?: string } {
  const match = pkgSpec.match(/^(@[^/@]+\/[^/@]+|[^/@]+?)(?:@([^@]+))?$/);
  if (!match) throw new Error(`Invalid npm package specification: "${pkgSpec}"`);
  return { name: match[1], ...(match[2] ? { version: match[2] } : {}) };
}

/** 目录 → `files` 映射（排除 .git / node_modules）。 */
async function collectDirFiles(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files[rel] = await fs.readFile(full, 'utf8');
    }
  };
  await walk(dir, '');
  return files;
}

/** Extension 入口文件相对路径（package.json pi/module/main 优先，其次约定名）。 */
function extensionEntryOf(files: Record<string, string>): string | undefined {
  const pkgRaw = files['package.json'];
  if (pkgRaw !== undefined) {
    try {
      const pkg = JSON.parse(pkgRaw) as { pi?: { extensions?: string[] }; module?: string; main?: string };
      const candidate = pkg.pi?.extensions?.[0] ?? pkg.module ?? pkg.main;
      if (typeof candidate === 'string' && candidate !== '') {
        const rel = candidate.replace(/^\.\//, '');
        if (files[rel] !== undefined) return rel;
      }
    } catch {
      // 非法 package.json：退回约定名
    }
  }
  for (const name of ['index.ts', 'index.mts', 'extension.ts', 'index.js', 'index.mjs']) {
    if (files[name] !== undefined) return name;
  }
  const tsEntries = Object.keys(files).filter((p) => /\.m?ts$/.test(p) && !p.endsWith('.d.ts'));
  if (tsEntries.length === 1) return tsEntries[0];
  const jsEntries = Object.keys(files).filter((p) => /\.m?js$/.test(p));
  if (jsEntries.length === 1) return jsEntries[0];
  return undefined;
}

/** 从 files 映射解析安装结果；无可用入口时抛错。 */
async function resolveFromDir(
  dir: string,
  input: LocalInstallInput,
  nameHint: string,
): Promise<LocalInstallResult> {
  const hasSkillMd = await fileExists(path.join(dir, 'SKILL.md'));
  const kind: 'skill' | 'extension' =
    input.kind && input.kind !== 'auto' ? input.kind : hasSkillMd ? 'skill' : 'extension';
  const id = sanitizeInstallId(input.customId || nameHint || path.basename(dir));
  const files = await collectDirFiles(dir);
  if (Object.keys(files).length === 0) {
    throw new Error(`No usable files found in "${input.source}"`);
  }
  if (kind === 'skill') {
    if (files['SKILL.md'] === undefined || !files['SKILL.md'].trim()) {
      throw new Error(`No usable SKILL.md found in "${input.source}"`);
    }
    return { kind, id, files, entry: 'SKILL.md' };
  }
  const entry = extensionEntryOf(files);
  if (entry === undefined || !files[entry].trim()) {
    throw new Error(`No usable entry file (.ts/index.ts) found in "${input.source}"`);
  }
  return { kind, id, files: withNormalizedEntry(files, entry), entry: 'index.ts' };
}

/**
 * npm: 包规范：装进临时 staging，取包入口与全部运行依赖（node_modules 随包复制），
 * 清理 staging 后安装产物仍可独立运行。
 */
async function installNpm(pkgSpec: string, input: LocalInstallInput): Promise<LocalInstallResult> {
  const { name: pkgName } = parseNpmSpec(pkgSpec);
  const id = sanitizeInstallId(input.customId || pkgName.replace(/^@[^/]+\//, ''));
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-hub-install-'));
  try {
    await fs.writeFile(
      path.join(staging, 'package.json'),
      JSON.stringify({ name: `botd-ext-${id}`, private: true }, null, 2),
      'utf8',
    );
    await execFileAsync('npm', ['install', pkgSpec, '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: staging,
      windowsHide: true,
    });
    const installedDir = path.join(staging, 'node_modules', pkgName);
    if (!(await fileExists(installedDir))) {
      throw new Error(`npm package "${pkgName}" not found after install`);
    }
    const files = await collectDirFiles(installedDir);
    if (Object.keys(files).length === 0) {
      throw new Error(`npm package "${pkgName}" contains no files`);
    }
    // Pi Package 兼容：包 manifest 带 pi.extensions 时优先用其首个扩展入口。
    let entry = extensionEntryOf(files);
    const pkgRaw = files['package.json'];
    if (pkgRaw !== undefined) {
      try {
        const pkg = JSON.parse(pkgRaw) as { pi?: { extensions?: string[] } };
        const rel = pkg.pi?.extensions?.[0]?.replace(/^\.\//, '');
        if (rel && files[rel] !== undefined) entry = rel;
      } catch {
        // 非法 package.json：保持约定入口
      }
    }
    if (entry === undefined) {
      throw new Error(`npm package "${pkgName}" has no usable extension entry file`);
    }
    if (files['package.json'] === undefined) {
      throw new Error(`npm package "${pkgName}" is missing package.json`);
    }
    // 运行依赖随包复制（<depsPrefix>/…），包根 package.json 重写依赖入口路径。
    const bundled: Record<string, string> = {};
    const depsDir = path.join(staging, 'node_modules');
    const depRoots = (await fs.readdir(depsDir).catch(() => [])).filter(
      (name) => name !== pkgName && name !== '.package-lock.json',
    );
    for (const depRoot of depRoots) {
      const depFiles = await collectDirFiles(path.join(depsDir, depRoot));
      for (const [rel, content] of Object.entries(depFiles)) {
        bundled[`${BUNDLED_DEPS_PREFIX}/${depRoot}/${rel}`] = content;
      }
    }
    // 入口相对依赖重写：入口文件位于包根时，相对导入 ./dep 需指向 npm/node_modules/dep。
    const pkg = JSON.parse(files['package.json']) as {
      pi?: { extensions?: string[] };
      module?: string;
      main?: string;
      type?: string;
    };
    const manifest: Record<string, unknown> = {
      name: `botd-ext-${id}`,
      private: true,
      type: pkg.type === 'commonjs' ? 'commonjs' : 'module',
    };
    if (pkg.pi?.extensions) {
      manifest.pi = { extensions: ['index.ts'] };
    }
    // 入口垫片：bare import 经由 ./npm/node_modules 解析，相对 import 保持包内路径。
    const shim = [
      `import ext from './npm/node_modules/${pkgName}/${entry.replace(/^\.\//, '')}';`,
      'export default ext;',
      '',
    ].join('\n');
    return {
      kind: 'extension',
      id,
      files: { ...bundled, ...files, 'package.json': JSON.stringify(manifest, null, 2), 'index.ts': shim },
      entry: 'index.ts',
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * 入口归一：单文件 / 自定义入口的扩展包落盘后必须存在 `index.ts`，
 * 否则 getExtensionContent 默认入口 / 动态加载器都解析不到。
 */
function withNormalizedEntry(files: Record<string, string>, entry: string): Record<string, string> {
  if (entry === 'index.ts' || files['index.ts'] !== undefined) return files;
  return { ...files, 'index.ts': files[entry] };
}

/** 标准嵌套技能根（Agent Skills 规范布局）。 */
const NESTED_SKILL_ROOTS = ['skills', path.join('.agents', 'skills'), path.join('.agent', 'skills')];

/** 根目录下的全部嵌套技能目录（各标准根合并）。 */
async function nestedSkillDirs(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const nestedRoot of NESTED_SKILL_ROOTS) {
    const nestedDir = path.join(root, nestedRoot);
    const entries = await fs.readdir(nestedDir).catch(() => []);
    for (const name of entries) {
      if (await fileExists(path.join(nestedDir, name, 'SKILL.md'))) found.push(name);
    }
  }
  return [...new Set(found)].sort();
}

/**
 * 在 Hub 本地解析并安装资源（不依赖任何外部节点）。
 * 成功返回完整文件包；来源无法本地解析时抛错（调用方决定是否回退节点）。
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
      const fileName = path.basename(localPath);
      return {
        kind,
        id: baseId,
        files:
          kind === 'skill'
            ? { 'SKILL.md': content }
            : withNormalizedEntry({ [fileName]: content }, fileName),
        entry: kind === 'skill' ? 'SKILL.md' : 'index.ts',
      };
    }
    if (stat?.isDirectory()) {
      return resolveFromDir(localPath, input, path.basename(localPath));
    }
    // 既不是存在的本地路径、也不是 git URL 简写时才继续到 (3)；
    // owner/repo 简写会命中 (3)，其余无法解析的来源直接报错。
    if (!/^[\w.-]+\/[\w.-]+(?:@[\w.-]+)?$/.test(source)) {
      throw new Error(`Install source not found locally and not a git/npm reference: "${source}"`);
    }
  }

  // (3) Git 仓库（浅克隆到临时目录，解析后即清理）
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-hub-git-'));
  try {
    const { repoUrl, branch, subPath, skillName, inferredName } = parseGitSource(source);
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', branch);
    cloneArgs.push(repoUrl, tempDir);
    await execFileAsync('git', cloneArgs, { cwd: os.tmpdir(), windowsHide: true });
    await fs.rm(path.join(tempDir, '.git'), { recursive: true, force: true }).catch(() => undefined);
    const root = subPath ? path.join(tempDir, subPath) : tempDir;
    if (!(await fileExists(root))) throw new Error(`Subpath "${subPath}" not found in repository`);
    // 根部无 SKILL.md 时尝试标准嵌套布局；多候选无显式选择时报错（不静默挑第一个）。
    if (!(await fileExists(path.join(root, 'SKILL.md')))) {
      const candidates = await nestedSkillDirs(root);
      if (candidates.length > 0) {
        const pick = skillName || input.customId;
        if (pick && candidates.includes(pick)) {
          return resolveFromDir(path.join(root, await rootOfSkill(root, pick)), input, pick);
        }
        if (pick && !candidates.includes(pick)) {
          throw new Error(`Skill "${pick}" not found in repository (available: ${candidates.join(', ')})`);
        }
        if (candidates.length > 1) {
          throw new Error(`Multiple skills found in repository (${candidates.join(', ')}); specify one via owner/repo@skillName or customId`);
        }
        return resolveFromDir(path.join(root, await rootOfSkill(root, candidates[0])), input, candidates[0]);
      }
    }
    return resolveFromDir(root, input, inferredName);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 嵌套技能名 → 所在目录（标准根逐一探测）。 */
async function rootOfSkill(root: string, name: string): Promise<string> {
  for (const nestedRoot of NESTED_SKILL_ROOTS) {
    const dir = path.join(root, nestedRoot, name);
    if (await fileExists(path.join(dir, 'SKILL.md'))) return path.join(nestedRoot, name);
  }
  throw new Error(`Skill "${name}" not found under standard skill roots`);
}
