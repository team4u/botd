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

export function parseGitSource(source: string): {
  repoUrl: string;
  branch?: string;
  subPath?: string;
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

  const cleanSource = source.replace(/\/+$/, '');
  const urlMatch = cleanSource.match(/(?:[:/])([^/:]+?)(?:\.git)?$/);
  const inferredName = urlMatch ? urlMatch[1] : path.basename(cleanSource);

  return {
    repoUrl: source,
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

    await fs.writeFile(
      path.join(targetDir, 'index.ts'),
      `import ext from '${pkgName}';\nexport default ext;\n`,
      'utf8'
    );

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
  }

  // Case 3: Git URL or repository
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'botd-install-'));
  try {
    const { repoUrl, branch, subPath, inferredName } = parseGitSource(source);
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) {
      cloneArgs.push('--branch', branch);
    }
    cloneArgs.push(repoUrl, tempDir);
    // Route git through the managed MinGit on Windows when nothing else exists.
    const prependPath = isWindows ? windowsShellPathPrefix(dataDir) : [];
    await runCommand('git', cloneArgs, { cwd: os.tmpdir(), prependPath });

    const extractedRoot = subPath ? path.join(tempDir, subPath) : tempDir;
    if (!(await fileExists(extractedRoot))) {
      throw new Error(`Subpath "${subPath}" not found in repository`);
    }

    const hasSkillMd = await fileExists(path.join(extractedRoot, 'SKILL.md'));
    const resolvedKind: 'skill' | 'extension' =
      input.kind && input.kind !== 'auto' ? input.kind : hasSkillMd ? 'skill' : 'extension';
    const id = sanitizeId(input.customId || inferredName);
    const destDir = path.join(dataDir, resolvedKind === 'skill' ? 'skills' : 'extensions', id);

    await fs.rm(destDir, { recursive: true, force: true });
    await ensureDir(path.dirname(destDir));
    await fs.cp(extractedRoot, destDir, {
      recursive: true,
      filter: (src) =>
        path.basename(src) !== '.git' && !src.endsWith('/.git') && !src.endsWith('\\.git'),
    });

    if (resolvedKind === 'extension' && (await fileExists(path.join(destDir, 'package.json')))) {
      await runCommand('npm', ['install', '--omit=dev'], { cwd: destDir, prependPath });
    }

    return { kind: resolvedKind, id };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
