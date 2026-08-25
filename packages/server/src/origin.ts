/**
 * Which origin a request claims to come from.
 *
 * Shared by the JSON API and the WebSocket upgrade because both need the same
 * answer for the same reason: the session is a cookie now, and a cookie is sent
 * by the browser whether or not the page that triggered the request belongs to
 * us. `SameSite=Lax` already stops the cross-site cases — a scripted POST and a
 * socket handshake from another site both count as cross-site, so neither
 * carries the cookie — but a socket that can move pieces and resign games is
 * worth a second lock, and this one costs a string comparison.
 */
import type { IncomingMessage } from 'node:http';
import type { Config } from './config.js';

const trim = (origin: string): string => origin.replace(/\/$/, '');

export const expectedOrigin = (req: IncomingMessage, config: Config): string | null => {
  if (config.publicOrigin) return trim(config.publicOrigin);
  const host = req.headers.host;
  if (!host) return null;
  const forwarded = config.trustProxy ? req.headers['x-forwarded-proto'] : undefined;
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim())
    ?? (config.secureCookies ? 'https' : 'http');
  return `${proto}://${host}`;
};

/**
 * A missing Origin is allowed: that is a client which is not a browser, and
 * therefore not something another site can aim at a logged-in player. A present
 * one has to match.
 */
export const originAllowed = (req: IncomingMessage, config: Config): boolean => {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  const expected = expectedOrigin(req, config);
  return expected === null || trim(origin) === expected;
};
