import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildDaemonSpawnSpec } from './daemon-launch.js';
import { writeSecureFile } from './storage.js';

export interface ServiceDescriptor {
  platform: string;
  configPath: string;
  targetPath?: string;
  content: string;
  installCmd: string[];
  uninstallCmd: string[];
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '\'':
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

export function generateServiceDescriptor(
  dataDir: string,
  platformOverride?: NodeJS.Platform,
): ServiceDescriptor {
  const platform = platformOverride ?? process.platform;
  const { execPath, args } = buildDaemonSpawnSpec({ dataDir });

  if (platform === 'darwin') {
    const configPath = path.join(dataDir, 'service', 'dev.botd.agent.plist');
    const targetPath = path.join(
      os.homedir(),
      'Library',
      'LaunchAgents',
      'dev.botd.agent.plist',
    );
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.botd.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(execPath)}</string>
    ${args.map((a) => `<string>${escapeXml(a)}</string>`).join('\n    ')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(dataDir, 'daemon.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(dataDir, 'daemon.log'))}</string>
</dict>
</plist>
`;
    return {
      platform: 'darwin',
      configPath,
      targetPath,
      content,
      installCmd: ['launchctl', 'load', '-w', targetPath],
      uninstallCmd: ['launchctl', 'unload', '-w', targetPath],
    };
  }

  if (platform === 'win32') {
    const configPath = path.join(dataDir, 'service', 'start-botd.cmd');
    const formattedArgs = args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');
    const content = `@echo off
"${execPath}" ${formattedArgs}
`;
    return {
      platform: 'win32',
      configPath,
      content,
      installCmd: [
        'schtasks',
        '/Create',
        '/F',
        '/SC',
        'ONLOGON',
        '/TN',
        'BotdNodeAgent',
        '/TR',
        `"${configPath}"`,
      ],
      uninstallCmd: ['schtasks', '/Delete', '/F', '/TN', 'BotdNodeAgent'],
    };
  }

  // Default to linux (systemd user unit)
  const configPath = path.join(dataDir, 'service', 'botd.service');
  const targetPath = path.join(
    os.homedir(),
    '.config',
    'systemd',
    'user',
    'botd.service',
  );
  const formattedCmd = [execPath, ...args]
    .map((arg) => (arg.includes(' ') ? `"${arg}"` : arg))
    .join(' ');
  const content = `[Unit]
Description=Botd Node Agent
After=network.target

[Service]
Type=simple
ExecStart=${formattedCmd}
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  return {
    platform: 'linux',
    configPath,
    targetPath,
    content,
    installCmd: ['systemctl', '--user', 'enable', '--now', 'botd.service'],
    uninstallCmd: ['systemctl', '--user', 'disable', '--now', 'botd.service'],
  };
}

export interface InstallNodeServiceOptions {
  dryRun?: boolean;
  platformOverride?: NodeJS.Platform;
}

export interface NodeServiceOperationResult {
  ok: boolean;
  platform: string;
  configPath: string;
  targetPath?: string;
  content: string;
  dryRun: boolean;
  installed?: boolean;
  message?: string;
}

export async function installNodeService(
  dataDir: string,
  options?: InstallNodeServiceOptions,
): Promise<NodeServiceOperationResult> {
  const desc = generateServiceDescriptor(dataDir, options?.platformOverride);
  const dryRun = options?.dryRun === true;

  // Always write to dataDir/service/
  await writeSecureFile(desc.configPath, desc.content);
  const metaPath = path.join(dataDir, 'service', 'service.json');
  await writeSecureFile(
    metaPath,
    JSON.stringify(
      {
        platform: desc.platform,
        configPath: desc.configPath,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  if (dryRun) {
    return {
      ok: true,
      platform: desc.platform,
      configPath: desc.configPath,
      targetPath: desc.targetPath,
      content: desc.content,
      dryRun: true,
      installed: true,
      message: `Dry run: service configuration generated at ${desc.configPath}`,
    };
  }

  // Real installation to user-level OS paths
  try {
    if (desc.targetPath) {
      await writeSecureFile(desc.targetPath, desc.content);
    }

    if (desc.platform === 'linux') {
      spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    }

    if (desc.installCmd.length > 0) {
      const res = spawnSync(desc.installCmd[0], desc.installCmd.slice(1), {
        stdio: 'pipe',
        encoding: 'utf8',
      });
      if (res.error || (res.status !== 0 && res.status !== null)) {
        const errDetail = res.error?.message || res.stderr || `exit code ${res.status}`;
        return {
          ok: true,
          platform: desc.platform,
          configPath: desc.configPath,
          targetPath: desc.targetPath,
          content: desc.content,
          dryRun: false,
          installed: false,
          message: `Service configuration created at ${desc.configPath}, but system registration returned: ${errDetail}`,
        };
      }
    }

    return {
      ok: true,
      platform: desc.platform,
      configPath: desc.configPath,
      targetPath: desc.targetPath,
      content: desc.content,
      dryRun: false,
      installed: true,
      message: `Service installed and started for ${desc.platform}`,
    };
  } catch (err: any) {
    return {
      ok: true,
      platform: desc.platform,
      configPath: desc.configPath,
      targetPath: desc.targetPath,
      content: desc.content,
      dryRun: false,
      installed: false,
      message: `Service configuration created at ${desc.configPath}, but system service registration failed: ${err?.message || String(err)}`,
    };
  }
}

export async function uninstallNodeService(
  dataDir: string,
  options?: InstallNodeServiceOptions,
): Promise<{ ok: boolean; platform: string; dryRun: boolean; message: string }> {
  const desc = generateServiceDescriptor(dataDir, options?.platformOverride);
  const dryRun = options?.dryRun === true;

  if (!dryRun) {
    try {
      if (desc.uninstallCmd.length > 0) {
        spawnSync(desc.uninstallCmd[0], desc.uninstallCmd.slice(1), { stdio: 'ignore' });
      }
    } catch {
      // ignore
    }

    if (desc.targetPath) {
      await fsPromises.rm(desc.targetPath, { force: true }).catch(() => {});
    }

    await fsPromises.rm(desc.configPath, { force: true }).catch(() => {});
    await fsPromises.rm(path.join(dataDir, 'service', 'service.json'), { force: true }).catch(() => {});
  } else {
    // In dry run, also clean up the configuration file generated for the test/run so uninstall is clean
    await fsPromises.rm(desc.configPath, { force: true }).catch(() => {});
    await fsPromises.rm(path.join(dataDir, 'service', 'service.json'), { force: true }).catch(() => {});
  }

  return {
    ok: true,
    platform: desc.platform,
    dryRun,
    message: dryRun
      ? `Dry run: uninstall commands simulated for ${desc.platform}`
      : `Service uninstalled for ${desc.platform}`,
  };
}

export async function getNodeServiceStatus(dataDir: string): Promise<{
  installed: boolean;
  platform?: string;
  configPath?: string;
}> {
  const metaPath = path.join(dataDir, 'service', 'service.json');
  try {
    if (fs.existsSync(metaPath)) {
      const raw = await fsPromises.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw) as { platform?: string; configPath?: string };
      if (meta && meta.configPath && fs.existsSync(meta.configPath)) {
        return { installed: true, platform: meta.platform, configPath: meta.configPath };
      }
    }
  } catch {
    // ignore
  }

  const candidates: Array<{ platform: string; file: string }> = [
    { platform: 'linux', file: path.join(dataDir, 'service', 'botd.service') },
    { platform: 'darwin', file: path.join(dataDir, 'service', 'dev.botd.agent.plist') },
    { platform: 'win32', file: path.join(dataDir, 'service', 'start-botd.cmd') },
  ];

  for (const { platform, file } of candidates) {
    if (fs.existsSync(file)) {
      return { installed: true, platform, configPath: file };
    }
  }

  return { installed: false };
}
