/**
 * Small pieces of shared knowledge the API exposes but that must not drag the
 * AI package (and its worker plumbing) into the server bundle.
 */
import { AI_LEVEL_RATING, PROVISIONAL_RD } from '@ccx/shared';
import type { UserRow } from './db.js';

export const isProvisional = (user: UserRow): boolean => user.rd > PROVISIONAL_RD;

/** Level metadata the lobby shows next to the difficulty dial. */
export const LEVELS_INFO = [
  { level: 1, zh: '新手', en: 'Beginner' },
  { level: 2, zh: '入门', en: 'Novice' },
  { level: 3, zh: '业余', en: 'Casual' },
  { level: 4, zh: '棋友', en: 'Club' },
  { level: 5, zh: '高手', en: 'Strong' },
  { level: 6, zh: '好手', en: 'Expert' },
  { level: 7, zh: '大师', en: 'Master' },
  { level: 8, zh: '特级大师', en: 'Grandmaster' },
].map((l) => ({ ...l, rating: AI_LEVEL_RATING[l.level] ?? 1500 }));
