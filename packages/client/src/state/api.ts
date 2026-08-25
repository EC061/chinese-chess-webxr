/** REST calls: sessions, accounts, headset pairing, ladder, server capabilities. */
import type { Lang } from '../i18n/index.js';

export interface ApiUser {
  id: string;
  name: string;
  rating: number;
  rd: number;
  provisional: boolean;
  guest: boolean;
  wins: number;
  losses: number;
  draws: number;
  aiWins: number;
  aiLosses: number;
  aiDraws: number;
}

export interface SessionInfo {
  /** Whether the cookie on this device outlives the browser being closed. */
  persist: boolean;
  guest: boolean;
}

export interface ServerCapabilities {
  allowGuests: boolean;
  rateAiGames: boolean;
  undoMakesUnrated: boolean;
  crossOriginIsolation: boolean;
  aiLevels: Array<{ level: number; zh: string; en: string; rating: number }>;
  linkPollIntervalMs: number;
}

export interface GameSummary {
  id: string;
  mode: 'pvp' | 'ai';
  aiLevel: number | null;
  result: 'red' | 'black' | 'draw';
  reason: string;
  rated: boolean;
  youWere: 'red' | 'black';
  at: number;
}

export interface SessionResponse {
  user: ApiUser;
  session: SessionInfo;
}

export interface LinkStart {
  /** Formatted for reading off a panel: `BKQP-7RTM`. */
  userCode: string;
  /** The secret half. Never displayed, never stored anywhere persistent. */
  deviceCode: string;
  expiresIn: number;
  interval: number;
  url: string;
}

export type LinkPoll =
  | { status: 'pending'; expiresIn: number }
  | { status: 'ready'; user: ApiUser; session: SessionInfo }
  | { status: 'denied' }
  | { status: 'expired' };

export interface LinkLookup {
  expiresIn: number;
  /** The guest the waiting headset is currently playing as, if it is claimable. */
  waiting: { name: string; claimable: boolean } | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  // The session is an HttpOnly cookie, so there is no header to attach — but
  // saying so out loud beats relying on the fetch default.
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(body.error ?? 'unknown'),
      String(body.message ?? body.error ?? res.statusText),
    );
  }
  return body as T;
};

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  capabilities: () => request<ServerCapabilities>('/api/config'),

  register: (name: string, password: string, persist: boolean) =>
    post<SessionResponse>('/api/register', { name, password, persist }),

  login: (name: string, password: string, persist: boolean) =>
    post<SessionResponse>('/api/login', { name, password, persist }),

  guest: (lang: Lang, persist: boolean, name?: string) =>
    post<SessionResponse>('/api/guest', { lang, persist, name }),

  /** Turn the current guest session into a real account, keeping its rating. */
  claim: (name: string, password: string) =>
    post<SessionResponse>('/api/claim', { name, password }),

  me: () => request<SessionResponse & { recent: GameSummary[] }>('/api/me'),

  setPersist: (persist: boolean) => post<SessionResponse>('/api/session/persist', { persist }),

  adopt: (token: string, persist: boolean) => request<SessionResponse>('/api/session/adopt', {
    method: 'POST',
    body: JSON.stringify({ persist }),
    headers: { Authorization: `Bearer ${token}` },
  }),

  logout: () => post<{ ok: true }>('/api/logout'),

  leaderboard: (limit = 25) =>
    request<{ entries: ApiUser[] }>(`/api/leaderboard?limit=${limit}`),

  link: {
    start: () => post<LinkStart>('/api/link/start'),
    poll: (userCode: string, deviceCode: string, persist: boolean) =>
      post<LinkPoll>('/api/link/poll', { userCode, deviceCode, persist }),
    lookup: (code: string) => post<LinkLookup>('/api/link/lookup', { code }),
    approve: (code: string, mode: 'attach' | 'claim', name: string, password: string) =>
      post<{ ok: true; mode: string; user: ApiUser }>('/api/link/approve', { code, mode, name, password }),
    deny: (code: string) => post<{ ok: true }>('/api/link/deny', { code }),
  },
};

/** Human-readable API error, in the current language. */
export const apiErrorText = (error: unknown, lang: Lang): string => {
  if (!(error instanceof ApiError)) {
    return lang === 'zh' ? '网络错误' : 'Network error';
  }
  const zh: Record<string, string> = {
    'bad-name': '昵称需为 2–20 个字符（字母、数字、空格、- _ .）',
    'bad-password': '密码至少 8 个字符',
    'name-taken': '这个昵称已被注册',
    'bad-credentials': '昵称或密码不对',
    'guests-disabled': '本服务器已关闭访客模式',
    'rate-limited': '操作太频繁，请稍后再试',
    'bad-code': '配对码应为 8 位字符',
    'no-such-code': '配对码无效或已过期，请在头显里重新生成',
    'not-claimable': '这台头显当前不是访客身份，无法保留积分',
    'already-claimed': '这个账号已经注册过了',
    'too-many-attempts': '尝试次数过多，请在头显里重新生成配对码',
    'too-many-codes': '待配对的请求太多，请先完成或取消现有的配对',
    'bad-origin': '请求来源不受信任',
    unauthorized: '登录状态已失效，请重新登录',
  };
  const en: Record<string, string> = {
    'bad-code': 'A pairing code is 8 characters',
    'no-such-code': 'That code has expired — start a new one in the headset',
    'not-claimable': 'That headset is not signed in as a guest, so there is no rating to keep',
    'already-claimed': 'That account already has a password',
    'too-many-attempts': 'Too many attempts — start a new code in the headset',
    'too-many-codes': 'Too many pairings waiting. Finish or cancel one first',
    'bad-origin': 'That request did not come from this site',
    unauthorized: 'Your session has expired — sign in again',
  };
  if (lang === 'zh') return zh[error.code] ?? error.message;
  return en[error.code] ?? error.message;
};

/**
 * Sessions used to be a token in localStorage. Devices signed in that way still
 * have one; trading it for a cookie once means nobody gets logged out by the
 * change, and the token stops being something a script on the page can read.
 */
const LEGACY_TOKEN_KEY = 'ccx.token';

export const takeLegacyToken = (): string | null => {
  try {
    const token = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (token) localStorage.removeItem(LEGACY_TOKEN_KEY);
    return token;
  } catch {
    return null;
  }
};
