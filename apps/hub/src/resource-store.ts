/**
 * Hub Skill / Extension 资源包的文件系统存储：`<dataDir>/skills/<id>` 与
 * `<dataDir>/extensions/<id>` 目录是唯一事实源，本模块只做纯文件系统读写与
 * 目录发现，与 SQLite 数据库完全解耦。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { decodePackageFile } from '@botd/protocol';

/** Hub 包文件写入载荷：文本直传，二进制/带可执行位的文件走保真形态。 */
export type HubPackageFileInput =
  | string
  | Buffer
  | { data: Buffer; executable?: boolean }
  | { content?: string; contentBase64?: string; executable?: boolean };

/** 写入单个包文件：string 按 utf8，Buffer 直写，对象形态解码后按需补可执行位。 */
function writePackageFile(target: string, relativePath: string, value: HubPackageFileInput): void {
  if (typeof value === 'string') {
    fs.writeFileSync(target, value, 'utf8');
    return;
  }
  if (Buffer.isBuffer(value)) {
    fs.writeFileSync(target, value);
    return;
  }
  if (Buffer.isBuffer((value as { data?: unknown }).data)) {
    const { data, executable } = value as { data: Buffer; executable?: boolean };
    fs.writeFileSync(target, data);
    if (executable === true) fs.chmodSync(target, 0o755);
    return;
  }
  const decoded = decodePackageFile({ path: relativePath, ...value });
  fs.writeFileSync(target, decoded.data);
  if (decoded.executable) fs.chmodSync(target, 0o755);
}

export interface HubResourceStoreOptions {
  /** 包目录根（skills/ 与 extensions/ 的父目录）。 */
  dataDir: string;
  /** 额外扫描 `.agents/skills` / `.agent/skills` 的基目录列表（如各 Bot 的 workspaceDir）。 */
  skillSearchDirs?: string[];
}

/** Skill / Extension 资源包的文件系统存储（目录为唯一事实源）。 */
export class HubResourceStore {
  private readonly dataDir: string;
  private readonly skillsRoot: string;
  private readonly extensionsRoot: string;
  private readonly skillSearchDirs: string[];

  constructor(options: HubResourceStoreOptions) {
    this.dataDir = options.dataDir;
    this.skillSearchDirs = options.skillSearchDirs ?? [];
    this.skillsRoot = path.join(this.dataDir, 'skills');
    this.extensionsRoot = path.join(this.dataDir, 'extensions');
    fs.mkdirSync(this.skillsRoot, { recursive: true });
    fs.mkdirSync(this.extensionsRoot, { recursive: true });
  }

  /** 包目录根（skills/ 与 extensions/ 的父目录）。 */
  getDataDir(): string {
    return this.dataDir;
  }

  /** 目录下所有文件的 POSIX 相对路径（排除 .git / node_modules），按字典序。 */
  private listFilesUnder(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string, prefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
        else if (entry.isFile()) out.push(rel);
      }
    };
    walk(dir, '');
    return out;
  }

  /** 包目录内的安全相对路径：拒绝空/绝对路径、NUL、逃逸包根。 */
  private safeJoin(pkgDir: string, relativePath: string): string {
    if (relativePath === '' || relativePath.includes('\0')) {
      throw new Error(`invalid relative path: ${JSON.stringify(relativePath)}`);
    }
    const resolved = path.resolve(pkgDir, relativePath);
    const rel = path.relative(pkgDir, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`relative path escapes package directory: ${relativePath}`);
    }
    return resolved;
  }

  /** 目录及其内文件的最大 mtime（ISO 字符串）；目录不存在返回 undefined。 */
  private latestMtimeUnder(dir: string): string | undefined {
    let latest = 0;
    const walk = (current: string): void => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(current);
      } catch {
        return;
      }
      latest = Math.max(latest, stat.mtimeMs);
      if (!stat.isDirectory()) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        walk(path.join(current, entry.name));
      }
    };
    walk(dir);
    return latest > 0 ? new Date(latest).toISOString() : undefined;
  }

  /** 扫描基目录下的 `.agents/skills` / `.agent/skills`（含 `skills` 兼容）里的技能目录。 */
  private discoverAgentSkillDirs(baseDirs: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    const subRoots = [path.join('.agents', 'skills'), path.join('.agent', 'skills'), 'skills'];
    for (const base of baseDirs) {
      for (const sub of subRoots) {
        const root = path.join(base, sub);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory() || found.has(entry.name)) continue;
          if (fs.existsSync(path.join(root, entry.name, 'SKILL.md'))) found.set(entry.name, path.join(root, entry.name));
        }
      }
    }
    return found;
  }

  /** 标准 Agent 技能根（进程 cwd 与用户 home 的 .agents/skills / .agent/skills）。 */
  private standardAgentSkillRoots(): string[] {
    return [
      path.join(process.cwd(), '.agents', 'skills'),
      path.join(process.cwd(), '.agent', 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
      path.join(os.homedir(), '.agent', 'skills'),
    ];
  }

  /** 包根下有效包目录 id 列表（仅含普通文件的目录才算包，忽略点开头目录）。 */
  private listPackageIds(root: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .filter((e) => this.listFilesUnder(path.join(root, e.name)).length > 0)
      .map((e) => e.name);
  }

  /** 目录是否非空（存在即可加载）。 */
  private dirHasContent(dir: string): boolean {
    try {
      return fs.readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  }

  // --- Skills ---------------------------------------------------------

  /**
   * 解析技能所在目录（优先级从高到低）：Hub dataDir、extraDirs、配置的
   * skillSearchDirs、标准 Agent 技能根。仅含 `SKILL.md` 的目录才算技能。
   */
  resolveSkillDir(id: string, extraDirs?: string[]): string | undefined {
    const candidates = [path.join(this.skillsRoot, id)];
    for (const base of [...(extraDirs ?? []), ...this.skillSearchDirs]) {
      candidates.push(
        path.join(base, '.agents', 'skills', id),
        path.join(base, '.agent', 'skills', id),
        path.join(base, 'skills', id),
        path.join(base, id),
      );
    }
    for (const root of this.standardAgentSkillRoots()) candidates.push(path.join(root, id));
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
    }
    return undefined;
  }

  /** Hub 托管技能目录（写入目标），与解析无关。 */
  getSkillDir(id: string): string {
    return path.join(this.skillsRoot, id);
  }

  /** 读取技能内相对路径的文件内容；技能不存在返回 ''。 */
  getSkillContent(id: string, relativePath = 'SKILL.md', extraDirs?: string[]): string {
    const dir = this.resolveSkillDir(id, extraDirs);
    if (dir === undefined) return '';
    try {
      return fs.readFileSync(this.safeJoin(dir, relativePath), 'utf8');
    } catch {
      return '';
    }
  }

  /** 写入 Hub 托管技能的单个文件（默认 `SKILL.md`）。 */
  saveSkillContent(id: string, content: string, relativePath = 'SKILL.md'): void {
    this.saveSkillFiles(id, { [relativePath]: content });
  }

  /** 写入 Hub 托管技能的全部文件（相对路径 → 内容；支持二进制与可执行位保真）。 */
  saveSkillFiles(id: string, files: Record<string, HubPackageFileInput>): void {
    const dir = this.getSkillDir(id);
    for (const [relativePath, value] of Object.entries(files)) {
      const target = this.safeJoin(dir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writePackageFile(target, relativePath, value);
    }
  }

  /** 技能目录内全部文件（排除 .git / node_modules）；不存在返回空数组。 */
  listSkillFiles(id: string, extraDirs?: string[]): string[] {
    const dir = this.resolveSkillDir(id, extraDirs);
    return dir === undefined ? [] : this.listFilesUnder(dir);
  }

  /** 全部可见技能：Hub 托管优先，叠加 extraDirs / skillSearchDirs 中发现的 `.agents/skills` 技能。 */
  listSkills(extraDirs?: string[]): Array<{ id: string; updatedAt: string; source: 'hub' | 'agent-dir' }> {
    const result = new Map<string, { id: string; updatedAt: string; source: 'hub' | 'agent-dir' }>();
    for (const [id, dir] of this.discoverAgentSkillDirs([this.dataDir, ...(extraDirs ?? []), ...this.skillSearchDirs])) {
      const updatedAt = this.latestMtimeUnder(dir) ?? new Date(0).toISOString();
      result.set(id, { id, updatedAt, source: 'agent-dir' });
    }
    // dataDir 直接视为 Hub 托管根（skills/<id>），覆盖 source 标记
    for (const id of this.listPackageIds(this.skillsRoot)) {
      const updatedAt = this.latestMtimeUnder(this.getSkillDir(id)) ?? new Date(0).toISOString();
      result.set(id, { id, updatedAt, source: 'hub' });
    }
    return [...result.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 删除 Hub 托管技能目录。 */
  deleteSkillContent(id: string): void {
    fs.rmSync(this.getSkillDir(id), { recursive: true, force: true });
  }

  // --- Extensions -----------------------------------------------------

  /** Hub 托管扩展包目录（写入与加载目标）。 */
  getExtensionDir(id: string): string {
    return path.join(this.extensionsRoot, id);
  }

  /** 读取 Hub 托管扩展内相对路径的文件内容；不存在返回 ''。 */
  getExtensionContent(id: string, relativePath = 'index.ts'): string {
    try {
      return fs.readFileSync(this.safeJoin(this.getExtensionDir(id), relativePath), 'utf8');
    } catch {
      return '';
    }
  }

  /** 写入 Hub 托管扩展的单个文件（默认 `index.ts`）。 */
  saveExtensionContent(id: string, content: string, relativePath = 'index.ts'): void {
    this.saveExtensionFiles(id, { [relativePath]: content });
  }

  /** 写入 Hub 托管扩展的全部文件（相对路径 → 内容；支持二进制与可执行位保真）。 */
  saveExtensionFiles(id: string, files: Record<string, HubPackageFileInput>): void {
    const dir = this.getExtensionDir(id);
    for (const [relativePath, value] of Object.entries(files)) {
      const target = this.safeJoin(dir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writePackageFile(target, relativePath, value);
    }
  }

  /** 扩展目录内全部文件（排除 node_modules / .git）；不存在返回空数组。 */
  listExtensionFiles(id: string): string[] {
    return this.listFilesUnder(this.getExtensionDir(id));
  }

  /** 全部 Hub 托管扩展（目录扫描，mtime 即 updatedAt）。 */
  listExtensions(): Array<{ id: string; updatedAt: string }> {
    return this.listPackageIds(this.extensionsRoot)
      .map((id) => ({
        id,
        updatedAt: this.latestMtimeUnder(this.getExtensionDir(id)) ?? new Date(0).toISOString(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 扩展目录是否存在且含文件（供运行时加载判断）。 */
  hasExtensionDir(id: string): boolean {
    return this.dirHasContent(this.getExtensionDir(id));
  }

  /** 删除 Hub 托管扩展目录。 */
  deleteExtensionContent(id: string): void {
    fs.rmSync(this.getExtensionDir(id), { recursive: true, force: true });
  }
}
