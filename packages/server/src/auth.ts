/**
 * Accounts, sessions, and headset pairing.
 *
 * Passwords use scrypt from `node:crypto` — no native dependency, and the
 * parameters below cost roughly 100 ms per hash on server-class hardware, which
 * is the point. Sessions are stateless HMAC tokens rather than database rows,
 * so a restart does not log everyone out and there is no session table to prune.
 *
 * The token travels in an HttpOnly cookie, not in a header the page can read.
 * That matters more here than on a normal site: a headset is signed in for
 * months at a time, so the credential sitting on the device is long-lived, and
 * script on the page must not be able to lift it. The same cookie authenticates
 * the WebSocket handshake, which is why the session no longer appears in a query
 * string (and therefore no longer in proxy logs).
 */
import { createHmac, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
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
  /**
   * Whether this session was issued as a persistent one on the device holding
   * it. Carried in the token so a refresh can re-issue the same *kind* of
   * cookie without the client having to ask for it again — and so the server,
   * not the page, decides how long the credential lives.
   */
  persist: boolean;
  /** Issued-at, epoch milliseconds. Used to decide when a refresh is worthwhile. */
  iat: number;
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
    // Tokens minted before sessions became cookie-borne carry neither flag.
    return {
      ...payload,
      guest: payload.guest === true,
      persist: payload.persist === true,
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
    };
  } catch {
    return null;
  }
};

/**
 * How long a session lasts. A headset is a device you sign into once, so the
 * persistent case is deliberately at the ceiling browsers will honour: Chromium
 * clamps any cookie expiry to 400 days from the moment it is set, and Meta's
 * browser is Chromium. Asking for more is silently truncated, so 400 days *is*
 * the maximum useful lifetime — and the reason every authenticated visit
 * re-stamps the cookie, which slides that window forward.
 */
export const MAX_COOKIE_DAYS = 400;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const tokenTtlMs = (persist: boolean, persistDays: number): number =>
  (persist ? Math.min(persistDays, MAX_COOKIE_DAYS) * 24 * 60 * 60 * 1000 : SESSION_TTL_MS);

// ------------------------------------------------------------------ cookies --

export const SESSION_COOKIE = 'ccx_session';

export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
};

export interface CookieOptions {
  /** Omit for a session cookie — one the browser drops when it closes. */
  maxAgeSeconds?: number | null;
  secure: boolean;
}

const cookieAttributes = (options: CookieOptions): string[] => {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.secure) attributes.push('Secure');
  if (options.maxAgeSeconds !== null && options.maxAgeSeconds !== undefined) {
    const seconds = Math.max(0, Math.floor(options.maxAgeSeconds));
    attributes.push(`Max-Age=${seconds}`);
    // Expires as well as Max-Age: the pair is what every browser in the field
    // agrees on, and a bare Max-Age is ignored by a few older WebViews.
    attributes.push(`Expires=${new Date(Date.now() + seconds * 1000).toUTCString()}`);
  }
  return attributes;
};

export const serializeSessionCookie = (token: string, options: CookieOptions): string =>
  [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, ...cookieAttributes(options)].join('; ');

export const clearedSessionCookie = (secure: boolean): string =>
  [`${SESSION_COOKIE}=`, ...cookieAttributes({ maxAgeSeconds: 0, secure })].join('; ');

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

const fromAlphabet = (length: number): string => {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
};

export const newRoomId = (): string => fromAlphabet(6);

export const newGameId = (): string => randomUUID();

// -------------------------------------------------------- headset pairing ---

/**
 * The pairing code a headset displays. Eight characters from the same
 * I/O/0/1-free alphabet as room codes: the player reads it off a panel inside
 * the headset and types it on their phone, so every character has to survive
 * being read at arm's length and typed by someone who cannot see their hands.
 *
 * Eight characters is 40 bits of space, but the code is not the credential —
 * see {@link newDeviceCode}. It only has to be unguessable enough that nobody
 * lands on a live one by accident, and short enough to retype without swearing.
 */
export const newUserCode = (): string => fromAlphabet(8);

export const formatUserCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * Accept a code the way a person types it: any case, with or without the dash,
 * with stray spaces. Returns null if it is not eight characters of the pairing
 * alphabet — a typed I, O, 0 or 1 is always a misreading, and telling the
 * player to look again beats silently polling a code that cannot exist.
 */
export const normaliseUserCode = (input: string): string | null => {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length !== 8) return null;
  for (const character of cleaned) if (!ROOM_ALPHABET.includes(character)) return null;
  return cleaned;
};

/**
 * The secret half of the pairing. The headset keeps this and nothing else ever
 * sees it; approving a code does not hand out a session, polling with the
 * matching device code does. Without this split, anyone who could guess or
 * shoulder-surf the eight-character code could claim the session it unlocks.
 */
export const newDeviceCode = (): string => randomBytes(32).toString('base64url');

export const hashDeviceCode = (secret: string, deviceCode: string): string =>
  createHmac('sha256', secret).update(`device:${deviceCode}`).digest('base64url');

export const deviceCodeMatches = (secret: string, deviceCode: string, stored: string): boolean => {
  const candidate = hashDeviceCode(secret, deviceCode);
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(stored));
};

// ---------------------------------------------------------- guest identity ---

/**
 * Names for players who never typed one. A generated name has to be worth
 * keeping — it goes on the ladder if they later claim the account — so these are
 * pieces and the way people describe playing them, rather than "Guest-4271".
 */
const GUEST_ADJECTIVES = {
  zh: ['疾风', '铁壁', '妙手', '稳健', '飞燕', '惊雷', '清风', '沉着', '无声', '闲云'],
  en: ['Swift', 'Steady', 'Clever', 'Bold', 'Quiet', 'Sharp', 'Calm', 'Lucky', 'Wary', 'Keen'],
} as const;

const GUEST_NOUNS = {
  zh: ['车', '马', '炮', '象', '士', '兵', '将'],
  en: ['Chariot', 'Horse', 'Cannon', 'Elephant', 'Advisor', 'Soldier', 'General'],
} as const;

export const newGuestName = (lang: 'zh' | 'en'): string => {
  const adjectives = GUEST_ADJECTIVES[lang];
  const nouns = GUEST_NOUNS[lang];
  const adjective = adjectives[randomInt(adjectives.length)]!;
  const noun = nouns[randomInt(nouns.length)]!;
  const suffix = randomInt(1000, 10000);
  return lang === 'zh' ? `${adjective}${noun} ${suffix}` : `${adjective} ${noun} ${suffix}`;
};
