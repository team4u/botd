/**
 * 工作区子包发现的单一事实源。
 *
 * 读取 pnpm-workspace.yaml 的 packages globs 并展开，供 bump-version 与
 * publish 复用；新增或更名子包时无需逐一同步脚本内的硬编码清单。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 子包描述：包名与对应目录 */
export interface WorkspacePackage {
  name: string;
  /** 包目录短名（workspace glob 下的目录名，如 protocol、hub、node） */
  shortName: string;
  dir: string;
}

/** 解析 pnpm-workspace.yaml 顶层的 packages 列表（简易行解析，够用且零依赖）。 */
function readWorkspaceGlobs(rootDir: string): string[] {
  const workspacePath = join(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) {
    throw new Error(`pnpm-workspace.yaml not found at ${workspacePath}`);
  }
  const lines = readFileSync(workspacePath, "utf8").split("\n");
  const globs: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages\s*:/.test(line)) {
      inPackages = !line.split(":")[1]?.trim();
      continue;
    }
    if (inPackages) {
      const match = line.trim().match(/^-\s*(\S+)$/);
      if (match) {
        globs.push(match[1]);
      } else if (line.trim() && !line.trim().startsWith("#")) {
        inPackages = false;
      }
    }
  }
  return globs;
}

/**
 * 发现工作区内全部子包（按目录名排序）。
 *
 * 仅展开 `<base>/*` 形态的 globs（当前仓库全部如此），逐目录读取 package.json。
 */
export function discoverWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const globs = readWorkspaceGlobs(rootDir);
  const packages: WorkspacePackage[] = [];

  for (const pattern of globs) {
    if (!pattern.endsWith("/*")) {
      continue;
    }
    const baseDir = join(rootDir, pattern.slice(0, -2));
    if (!existsSync(baseDir)) {
      continue;
    }
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgDir = join(baseDir, entry.name);
      const pkgJsonPath = join(pkgDir, "package.json");
      if (!existsSync(pkgJsonPath)) {
        continue;
      }
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (pkgJson.name) {
        packages.push({ name: pkgJson.name, shortName: entry.name, dir: pkgDir });
      }
    }
  }

  packages.sort((a, b) => a.shortName.localeCompare(b.shortName));
  return packages;
}
