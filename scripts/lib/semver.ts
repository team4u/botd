/**
 * 工程脚本共享的语义化版本纯函数库。
 */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

/**
 * 解析语义化版本号（容忍可选的 v 前缀），非法输入抛出错误。
 */
export function parseSemver(v: string): Semver {
  const match = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error(`非法的语义化版本号: '${v}'`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || null,
  };
}

export type BumpType = "patch" | "minor" | "major" | "prerelease";

/**
 * 按指定类型递增版本号。prerelease 类型在已有预发布后缀时递增其序号，
 * 否则从 patch 递增并附加 `${preId}.0`。
 */
export function bumpSemver(current: string, type: BumpType, preId = "beta"): string {
  const parsed = parseSemver(current);
  if (type === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (type === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  if (type === "patch") {
    if (parsed.prerelease) {
      return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    }
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }
  if (type === "prerelease") {
    if (parsed.prerelease) {
      const match = parsed.prerelease.match(/^(.*?)(?:\.(\d+))?$/);
      if (match) {
        const id = match[1];
        const num = match[2] ? parseInt(match[2], 10) + 1 : 0;
        return `${parsed.major}.${parsed.minor}.${parsed.patch}-${id}.${num}`;
      }
    }
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-${preId}.0`;
  }
  return current;
}

/**
 * 从版本号解析预发布分发标签（如 `1.0.0-beta.3` 提取 `beta`），非预发布返回 null。
 */
export function extractPrereleaseTag(version: string): string | null {
  const parsed = parseSemver(version);
  if (!parsed.prerelease) return null;
  const match = parsed.prerelease.match(/^([a-zA-Z]+)(?:\.|\b)/);
  return match ? match[1].toLowerCase() : null;
}
