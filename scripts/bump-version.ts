/**
 * 全仓版本号统一同步脚本。
 *
 * 用法: node scripts/bump-version.ts <version> [--dry-run]
 *
 * 遍历根 package.json 与所有 workspace 子包的 package.json，统一改写 version
 * 字段。纯 JSON 读写，不需要 install。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSemver } from "./lib/semver.ts";
import { discoverWorkspacePackages } from "./lib/workspace-packages.ts";

const rootDir = resolve(import.meta.dirname, "..");

function printHelp(): void {
  console.log(`
用法: node scripts/bump-version.ts <version> [--dry-run]

参数选项:
  <version>   目标版本号（如 0.2.0、1.0.0-beta.1）
  --dry-run   只打印计划，不修改任何文件
`);
}

function bumpPackageJson(filePath: string, version: string, dryRun: boolean): void {
  const raw = readFileSync(filePath, "utf8");
  const pkg = JSON.parse(raw);
  const oldVersion = pkg.version;
  pkg.version = version;
  // 2 空格缩进 + 末尾换行，与仓库现有 JSON 风格一致
  const output = `${JSON.stringify(pkg, null, 2)}\n`;
  if (dryRun) {
    console.log(`[模拟] ${filePath}: ${oldVersion} -> ${version}`);
  } else {
    writeFileSync(filePath, output, "utf8");
    console.log(`${filePath}: ${oldVersion} -> ${version}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const versionArg = args.find((a) => !a.startsWith("--"));

  if (!versionArg || args.includes("--help") || args.includes("-h")) {
    printHelp();
    if (!versionArg) process.exit(1);
    return;
  }

  const version = versionArg.replace(/^v/, "");
  parseSemver(version);

  const targets = [
    join(rootDir, "package.json"),
    ...discoverWorkspacePackages(rootDir).map((pkg) => join(pkg.dir, "package.json")),
  ];

  console.log(`同步全仓版本号至 ${version}（${targets.length} 个 package.json）...`);
  for (const filePath of targets) {
    bumpPackageJson(filePath, version, dryRun);
  }
}

main();
