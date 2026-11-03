import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDir } from './storage.js';
import { isWindows, windowsShellPathPrefix } from './windows-shell.js';

const execFileAsync = promisify(execFile);

/**
 * npm is npm.cmd on Windows and cannot be exec'd directly by Node ≥ 20.
 * The optional prepend lets callers route git through the managed MinGit.
 */
async function runCommand(command: string, args: string[], options: { cwd: string; prependPath?: string[] }): Promise<{ stdout: string; stderr: string }> {
  const resolved = isWindows && (command === 'npm' || command === 'npx') ? `${command}.cmd` : command;
  const pathKey = isWindows
    ? (Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH')
    : 'PATH';
  const currentPath = process.env[pathKey] ?? '';
  const nextPath = [
    ...(options.prependPath ?? []),
    ...currentPath.split(path.delimiter).filter(Boolean),
  ].join(path.delimiter);
  return execFileAsync(resolved, args, {
    cwd: options.cwd,
    windowsHide: true,
    env: { ...process.env, [pathKey]: nextPath, PATH: nextPath },
  });
}

export interface InstallInput {
  source: string;
  kind?: 'auto' | 'skill' | 'extension';
  customId?: string;
}

export function sanitizeId(input: string): string {
  const sanitized = input
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!sanitized) {
    throw new Error(`Invalid identifier: "${input}"`);
  }
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

async function copyTreeExcludingGit(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, {
    recursive: true,
    filter: (candidate) => path.basename(candidate) !== '.git',
  });
}

/** Standard skill roots a repository may carry (Agent Skills spec layouts). */
const NESTED_SKILL_ROOTS = ['skills', path.join('.agents', 'skills'), path.join('.agent', 'skills')];

/** Locate a skill below a cloned repo root: `skills/<name>`, `.agents/skills/<name>`
 *  or `.agent/skills/<name>`. With a target name only that name matches; without
 *  one the layout must be unambiguous (exactly one skill dir found). */
async function findNestedSkillDir(
  repoRoot: string,
  target?: string
): Promise<{ dir: string; name: string } | null> {
  if (target) {
    if (path.basename(target) !== target) return null; // refuse traversal-ish names
    for (const root of NESTED_SKILL_ROOTS) {
      const dir = path.join(repoRoot, root, target);
      if (await fileExists(path.join(dir, 'SKILL.md'))) return { dir, name: target };
    }
    return null;
  }
  const found: { dir: string; name: string }[] = [];
  for (const root of NESTED_SKILL_ROOTS) {
    const rootDir = path.join(repoRoot, root);
    if (!(await fileExists(rootDir))) continue;
    const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (await fileExists(path.join(rootDir, entry.name, 'SKILL.md'))) {
        found.push({ dir: path.join(rootDir, entry.name), name: entry.name });
      }
    }
  }
  return found.length === 1 ? found[0] : null;
}

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

export async function installResourceToNode(
  dataDir: string,
  input: InstallInput
): Promise<{ kind: 'skill' | 'extension'; id: string }> {
  const source = input.source.trim();
  if (!source) {
    throw new Error('Install source cannot be empty');
  }

  // Case 1: NPM package specification
  if (source.startsWith('npm:')) {
    const pkgSpec = source.slice(4).trim();
    if (!pkgSpec) {
      throw new Error('NPM package specification cannot be empty');
    }
    const pkgNameMatch = pkgSpec.match(/^(@[^/@]+\/[^/@]+|[^/@]+)/);
    const pkgName = pkgNameMatch ? pkgNameMatch[1] : pkgSpec;
    const id = sanitizeId(input.customId || pkgName.replace(/^@[^/]+\//, ''));
    const targetDir = path.join(dataDir, 'extensions', id);

    await fs.rm(targetDir, { recursive: true, force: true });
    await ensureDir(targetDir);

    await fs.writeFile(
      path.join(targetDir, 'package.json'),
      JSON.stringify({ name: `botd-ext-${id}`, private: true }, null, 2),
      'utf8'
    );

    await runCommand('npm', ['install', pkgSpec, '--omit=dev'], { cwd: targetDir });

    // Pi Package compatibility: a package manifest with a `pi` field (e.g.
    // { "pi": { "extensions": ["./dist/index.js"] } }) is passed through by
    // rewriting its relative extension paths against the install dir — the
    // loader natively recognizes a `pi` field in this package.json, so no
    // index.ts shim is generated in that case.
    const installedPkgJson = path.join(targetDir, 'node_modules', pkgName, 'package.json');
    let piExtensions: string[] | undefined;
    try {
      const pkg = JSON.parse(await fs.readFile(installedPkgJson, 'utf8')) as Record<string, unknown>;
      const pi = pkg?.pi;
      if (pi && typeof pi === 'object' && Array.isArray((pi as { extensions?: unknown }).extensions)) {
        piExtensions = (pi as { extensions: unknown[] }).extensions.filter(
          (rel): rel is string => typeof rel === 'string'
        );
      }
    } catch {
      // No readable package.json — fall back to the index.ts shim below.
    }

    if (piExtensions && piExtensions.length > 0) {
      const manifestPath = path.join(targetDir, 'package.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.pi = {
        extensions: piExtensions.map((rel) => `./node_modules/${pkgName}/${rel.replace(/^\.\//, '')}`),
      };
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    } else {
      await fs.writeFile(
        path.join(targetDir, 'index.ts'),
        `import ext from '${pkgName}';\nexport default ext;\n`,
        'utf8'
      );
    }

    return { kind: 'extension', id };
  }

  // Case 2: Local file (.ts, .js, .md)
  if (
    !source.startsWith('http://') &&
    !source.startsWith('https://') &&
    !source.startsWith('git@') &&
    !source.startsWith('file://')
  ) {
    let stat: import('node:fs').Stats | null = null;
    try {
      stat = await fs.stat(source);
    } catch {
      // Inaccessible or not a local path
    }

    if (stat && stat.isFile()) {
      const ext = path.extname(source);
      const baseId = sanitizeId(input.customId || path.basename(source, ext));
      const isSkill =
        input.kind === 'skill' || (input.kind !== 'extension' && source.endsWith('.md'));

      if (isSkill) {
        const destDir = path.join(dataDir, 'skills', baseId);
        await ensureDir(destDir);
        await fs.copyFile(source, path.join(destDir, 'SKILL.md'));
        return { kind: 'skill', id: baseId };
      } else {
        const destDir = path.join(dataDir, 'extensions', baseId);
        await ensureDir(destDir);
        await fs.copyFile(source, path.join(destDir, 'index.ts'));
        return { kind: 'extension', id: baseId };
      }
    }

    // Local directory: a skill ships SKILL.md at its root, anything else is
    // treated as an extension directory.
    if (stat && stat.isDirectory()) {
      const hasSkillMd = await fileExists(path.join(source, 'SKILL.md'));
      const resolvedKind: 'skill' | 'extension' =
        input.kind && input.kind !== 'auto' ? input.kind : hasSkillMd ? 'skill' : 'extension';
      const id = sanitizeId(input.customId || path.basename(source));
      const destDir = path.join(dataDir, resolvedKind === 'skill' ? 'skills' : 'extensions', id);
      await fs.rm(destDir, { recursive: true, force: true });
      await ensureDir(path.dirname(destDir));
      await copyTreeExcludingGit(source, destDir);
      return { kind: resolvedKind, id };
    }
  }

  // Case 3: Git URL or repository
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-install-'));
  try {
    const { repoUrl, branch, subPath, skillName, inferredName } = parseGitSource(source);

    const cloneInto = async (dir: string, ref?: string): Promise<void> => {
      const cloneArgs = ['clone', '--depth', '1'];
      if (ref) cloneArgs.push('--branch', ref);
      cloneArgs.push(repoUrl, dir);
      // Route git through the managed MinGit on Windows when nothing else exists.
      const prependPath = isWindows ? windowsShellPathPrefix(dataDir) : [];
      await runCommand('git', cloneArgs, { cwd: os.tmpdir(), prependPath });
    };

    await cloneInto(tempDir, branch);

    const extractedRoot = subPath ? path.join(tempDir, subPath) : tempDir;
    if (!(await fileExists(extractedRoot))) {
      throw new Error(`Subpath "${subPath}" not found in repository`);
    }

    // No SKILL.md at the root: look for the standard nested skill layouts
    // (skills/<name>, .agents/skills/<name>, .agent/skills/<name>) that skill
    // repositories use; `owner/repo@skillName` or customId picks the name.
    let sourceRoot = extractedRoot;
    let nameHint = inferredName;
    let nestedMissing = false;
    if (!(await fileExists(path.join(extractedRoot, 'SKILL.md')))) {
      const nested = await findNestedSkillDir(extractedRoot, skillName || input.customId);
      if (nested) {
        sourceRoot = nested.dir;
        nameHint = nested.name;
      } else {
        nestedMissing = true;
      }
    }

    // `owner/repo@target` with no nested skill of that name: treat the suffix
    // as a git tag/branch and re-clone at that ref (Pi `@ref` semantics).
    if (nestedMissing && skillName && !subPath && input.kind !== 'skill') {
      const retryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-install-'));
      try {
        await cloneInto(retryDir, skillName);
        const retryRoot = (await fileExists(path.join(retryDir, 'SKILL.md')))
          ? retryDir
          : (await findNestedSkillDir(retryDir, input.customId))?.dir;
        if (!retryRoot) {
          throw new Error(`Ref "${skillName}" not found in ${repoUrl} (no nested skill and no such tag/branch)`);
        }
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        return await finalizeClonedResource(dataDir, retryDir, retryRoot, input, skillName);
      } finally {
        await fs.rm(retryDir, { recursive: true, force: true }).catch(() => {});
      }
    }

    return await finalizeClonedResource(dataDir, tempDir, sourceRoot, input, nameHint);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Copy the chosen source root into dataDir as a skill or extension and install
 *  npm deps for extension dirs that carry a package.json. `cloneDir` is removed
 *  once the copy completes (callers must NOT clean it before awaiting this). */
async function finalizeClonedResource(
  dataDir: string,
  cloneDir: string,
  sourceRoot: string,
  input: InstallInput,
  nameHint: string
): Promise<{ kind: 'skill' | 'extension'; id: string }> {
  try {
    const hasSkillMd = await fileExists(path.join(sourceRoot, 'SKILL.md'));
    const resolvedKind: 'skill' | 'extension' =
      input.kind && input.kind !== 'auto' ? input.kind : hasSkillMd ? 'skill' : 'extension';
    const id = sanitizeId(input.customId || nameHint);
    const destDir = path.join(dataDir, resolvedKind === 'skill' ? 'skills' : 'extensions', id);

    await fs.rm(destDir, { recursive: true, force: true });
    await ensureDir(path.dirname(destDir));
    await copyTreeExcludingGit(sourceRoot, destDir);

    if (resolvedKind === 'extension' && (await fileExists(path.join(destDir, 'package.json')))) {
      const prependPath = isWindows ? windowsShellPathPrefix(dataDir) : [];
      await runCommand('npm', ['install', '--omit=dev'], { cwd: destDir, prependPath });
    }

    return { kind: resolvedKind, id };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
