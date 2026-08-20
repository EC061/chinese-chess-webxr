/**
 * Static file serving with the headers WebXR and the multi-threaded AI need.
 *
 * The two that matter most:
 *  - COOP/COEP, without which `SharedArrayBuffer` is unavailable and the AI
 *    falls back to a single search thread.
 *  - `Permissions-Policy: xr-spatial-tracking`, without which the headset will
 *    not grant an immersive session.
 */
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.hdr': 'image/vnd.radiance',
  '.ktx2': 'image/ktx2',
  '.nnue': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' is only needed if an external UCI/WASM engine is dropped
  // in under /engines; the built-in AI is plain JavaScript.
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export const applySecurityHeaders = (res: ServerResponse, config: Config): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  // WebXR will not start an immersive session without this.
  res.setHeader('Permissions-Policy', 'xr-spatial-tracking=(self)');
  if (config.crossOriginIsolation) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  if (config.env === 'production' && config.publicOrigin?.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
};

export interface StaticHandler {
  (req: IncomingMessage, res: ServerResponse): boolean;
}

export const createStaticHandler = (config: Config): StaticHandler => {
  const root = resolve(config.staticDir);

  const send = (
    res: ServerResponse, filePath: string, status: number, immutable: boolean,
  ): boolean => {
    let stat;
    try {
      stat = statSync(filePath);
      if (!stat.isFile()) return false;
    } catch {
      return false;
    }
    res.statusCode = status;
    res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader(
      'Cache-Control',
      // Vite emits content-hashed asset names, so those can be cached forever;
      // the entry document must never be, or clients pin to an old build.
      immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    );
    createReadStream(filePath).pipe(res);
    return true;
  };

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Contain the path inside the static root, whatever the client sends.
    const candidate = resolve(join(root, normalize(pathname)));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return true;
    }

    const immutable = pathname.startsWith('/assets/');
    if (send(res, candidate, 200, immutable)) return true;

    // Single-page app: unknown paths that are not asset requests get the shell.
    if (!extname(pathname)) return send(res, join(root, 'index.html'), 200, false);
    return false;
  };
};
