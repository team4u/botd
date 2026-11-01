import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MiddlewareHandler } from 'hono';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

export function createStaticMiddleware(webDir?: string): MiddlewareHandler {
  const resolvedDir = path.resolve(
    webDir || process.env.BOTD_WEB_DIR || fileURLToPath(new URL('../../web/dist/', import.meta.url))
  );

  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const reqPath = c.req.path;

    // Do not interfere with API or WebSocket routes
    if (reqPath.startsWith('/api') || reqPath.startsWith('/ws')) {
      return next();
    }

    if (!fs.existsSync(resolvedDir)) {
      return next();
    }

    let cleanPath: string;
    try {
      cleanPath = decodeURIComponent(reqPath);
    } catch {
      return c.text('Invalid path', 400);
    }
    const targetPath = path.resolve(resolvedDir, `.${cleanPath === '/' ? '/index.html' : cleanPath}`);
    const relativePath = path.relative(resolvedDir, targetPath);

    if (relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      return c.text('Forbidden', 403);
    }

    try {
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        const ext = path.extname(targetPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const fileContent = fs.readFileSync(targetPath);
        return c.body(fileContent, 200, {
          'Content-Type': contentType,
        });
      }

      // SPA Fallback: serve index.html for GET/HEAD
      if (c.req.method === 'GET' || c.req.method === 'HEAD') {
        const indexPath = path.join(resolvedDir, 'index.html');
        if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
          const fileContent = fs.readFileSync(indexPath);
          return c.body(fileContent, 200, {
            'Content-Type': 'text/html; charset=utf-8',
          });
        }
      }
    } catch {
      // Fall through on error
    }

    return next();
  };
}
