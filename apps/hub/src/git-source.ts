/**
 * Git 来源解析（Hub 与 Node 安装器共享，避免 Hub 跨 rootDir import Node 源）。
 *
 * 支持：GitHub tree 链接、`git:` 前缀（Pi package 风格 `git:github.com/owner/repo@v1`、
 * `git:https://…`）、带 `@ref` 的完整 URL、`owner/repo` 与 `owner/repo@skillName` 简写。
 */
import path from 'node:path';

export function parseGitSource(source: string): {
  repoUrl: string;
  branch?: string;
  subPath?: string;
  /** Skill picked via the `owner/repo@skillName` shorthand, if any. */
  skillName?: string;
  inferredName: string;
} {
  const treeMatch = source.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/
  );
  if (treeMatch) {
    const [, owner, repo, branch, subPath] = treeMatch;
    const cleanRepo = repo.replace(/\.git$/, '');
    let inferredName = cleanRepo;
    if (subPath) {
      const segments = subPath.split('/').filter(Boolean);
      if (segments.length > 0) {
        inferredName = segments[segments.length - 1];
      }
    }
    return {
      repoUrl: `https://github.com/${owner}/${cleanRepo}.git`,
      branch,
      subPath,
      inferredName,
    };
  }

  // Pi-package style `git:` sources: `git:github.com/owner/repo@v1.0.0`,
  // `git:https://github.com/owner/repo@main`. Strip the prefix, normalize bare
  // hostnames to https URLs, and peel a trailing `@ref` into `branch`.
  const gitPrefixed = source.startsWith('git:');
  let normalized = source;
  if (gitPrefixed) {
    normalized = source.slice(4);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
  }

  // Full git URLs (original or normalized) with a trailing `@ref` (branch/tag):
  // `https://github.com/owner/repo@v1.0.0`, `git:github.com/owner/repo@v1`.
  // The `@` separator must sit in the last path segment (after host and repo)
  // so usernames (`https://user@host/...`) never match.
  const urlRefMatch = normalized.match(/^(https?:\/\/[^\/@\s]+\/[^\/@\s]+?\/[^\/@\s]+?)@([\w.\/-]+)$/);
  if (urlRefMatch) {
    const [, baseUrl, ref] = urlRefMatch;
    const repoUrl = /\.git$/.test(baseUrl) ? baseUrl : `${baseUrl}.git`;
    const nameMatch = baseUrl.match(/([^/]+?)(?:\.git)?$/);
    return { repoUrl, branch: ref, inferredName: nameMatch ? nameMatch[1] : ref };
  }

  // `npx skills add` style GitHub shorthand: owner/repo or owner/repo@skillName.
  // Only reached for sources that are not existing local paths (the local-path
  // case above already tried stat and fell through otherwise).
  const shorthandMatch = source.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([\w.-]+))?$/);
  if (shorthandMatch && shorthandMatch[1] !== '.' && shorthandMatch[1] !== '..') {
    const [, owner, repo, skillName] = shorthandMatch;
    return {
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      skillName,
      inferredName: skillName || repo,
    };
  }

  // Plain `git:` source without a ref: use the normalized URL for cloning.
  const cleanSource = (gitPrefixed ? normalized : source).replace(/\/+$/, '');
  const urlMatch = cleanSource.match(/(?:[:/])([^/:]+?)(?:\.git)?$/);
  const inferredName = urlMatch ? urlMatch[1] : path.basename(cleanSource);

  // Normalized github.com URLs clone fine either way; append `.git` for
  // consistency with the other GitHub-derived repoUrls.
  const repoUrl = gitPrefixed && /^https:\/\/[^\/]+\/[^\/]+\/[^\/]+$/.test(cleanSource)
    ? `${cleanSource}.git`
    : cleanSource;

  return {
    repoUrl,
    inferredName,
  };
}
