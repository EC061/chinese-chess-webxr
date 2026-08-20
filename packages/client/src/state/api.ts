/** REST calls: accounts, ladder, server capabilities. */
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

export interface ServerCapabilities {
  allowGuests: boolean;
  rateAiGames: boolean;
  undoMakesUnrated: boolean;
  crossOriginIsolation: boolean;
  aiLevels: Array<{ level: number; zh: string; en: string; rating: number }>;
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

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit & { token?: string }): Promise<T> => {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (init?.token) headers.set('Authorization', `Bearer ${init.token}`);
  const res = await fetch(path, { ...init, headers });
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

export const api = {
  capabilities: () => request<ServerCapabilities>('/api/config'),

  register: (name: string, password: string) =>
    request<{ token: string; user: ApiUser }>('/api/register', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    }),

  login: (name: string, password: string) =>
    request<{ token: string; user: ApiUser }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    }),

  guest: (name: string) =>
    request<{ token: string; user: ApiUser }>('/api/guest', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  me: (token: string) =>
    request<{ user: ApiUser; recent: GameSummary[] }>('/api/me', { token }),

  leaderboard: (limit = 25) =>
    request<{ entries: ApiUser[] }>(`/api/leaderboard?limit=${limit}`),
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
  };
  return lang === 'zh' ? zh[error.code] ?? error.message : error.message;
};

const TOKEN_KEY = 'ccx.token';
export const loadToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const saveToken = (token: string | null): void => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};
