/**
 * Accounts and sessions.
 *
 * Passwords use scrypt from `node:crypto` — no native dependency, and the
 * parameters below cost roughly 100 ms per hash on server-class hardware, which
 * is the point. Sessions are stateless HMAC tokens rather than database rows,
 * so a restart does not log everyone out and there is no session table to prune.
 */
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;

export const NAME_PATTERN = /^[\p{L}\p{N}_\-. ]{2,20}$/u;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  try {
    const derived = await scryptAsync(
      password, Buffer.from(salt!, 'base64url'), KEY_LENGTH,
      { N: Number(N), r: Number(r), p: Number(p) },
    );
    const expectedBuf = Buffer.from(expected!, 'base64url');
    return derived.length === expectedBuf.length && timingSafeEqual(derived, expectedBuf);
  } catch {
    return false;
  }
};

export interface TokenPayload {
  sub: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
  guest: boolean;
}

const sign = (secret: string, data: string): string =>
  createHmac('sha256', secret).update(data).digest('base64url');

export const issueToken = (secret: string, payload: TokenPayload): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
};

export const verifyToken = (secret: string, token: string): TokenPayload | null => {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(secret, body);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A room passcode is short-lived, so an HMAC keyed on the server secret is
 *  the right cost — it must not be reversible, but it is not a stored
 *  credential and never leaves memory. */
export const hashPasscode = (secret: string, roomId: string, passcode: string): string =>
  createHmac('sha256', secret).update(`${roomId}:${passcode}`).digest('base64url');

export const passcodeMatches = (
  secret: string, roomId: string, passcode: string, stored: string,
): boolean => {
  const candidate = hashPasscode(secret, roomId, passcode);
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
};

/** Short, unambiguous room codes players can read out loud in VR. */
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newRoomId = (): string => {
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
};

export const newGameId = (): string => randomUUID();
