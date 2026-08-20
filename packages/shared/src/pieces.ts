/** Bilingual piece metadata: what the hover label, move list, and tray show. */
import {
  ADVISOR, BLACK, CANNON, CHARIOT, ELEPHANT, GENERAL, HORSE, RED, SOLDIER, colorOf, typeOf,
  type Color, type Piece, type PieceType,
} from './types.js';

export type Lang = 'zh' | 'en';

export interface PieceInfo {
  type: PieceType;
  /** Character painted on the disc, which differs by side for five of the seven. */
  glyph: Record<Color, string>;
  /** English name shown on hover when the UI language is English. */
  en: string;
  /** Latin abbreviation used in compact UI (trays, captured lists). */
  abbr: string;
  /** Pinyin, shown as a pronunciation hint in English mode. */
  pinyin: Record<Color, string>;
  /** Rough material worth, in soldier units — surfaced in the tutorial. */
  value: number;
}

export const PIECE_INFO: Record<PieceType, PieceInfo> = {
  [GENERAL]: {
    type: GENERAL,
    glyph: { [RED]: '帅', [BLACK]: '将' },
    en: 'General',
    abbr: 'G',
    pinyin: { [RED]: 'shuài', [BLACK]: 'jiàng' },
    value: 0,
  },
  [ADVISOR]: {
    type: ADVISOR,
    glyph: { [RED]: '仕', [BLACK]: '士' },
    en: 'Advisor',
    abbr: 'A',
    pinyin: { [RED]: 'shì', [BLACK]: 'shì' },
    value: 2,
  },
  [ELEPHANT]: {
    type: ELEPHANT,
    glyph: { [RED]: '相', [BLACK]: '象' },
    en: 'Elephant',
    abbr: 'E',
    pinyin: { [RED]: 'xiàng', [BLACK]: 'xiàng' },
    value: 2,
  },
  [HORSE]: {
    type: HORSE,
    glyph: { [RED]: '马', [BLACK]: '马' },
    en: 'Horse',
    abbr: 'H',
    pinyin: { [RED]: 'mǎ', [BLACK]: 'mǎ' },
    value: 4,
  },
  [CHARIOT]: {
    type: CHARIOT,
    glyph: { [RED]: '车', [BLACK]: '车' },
    en: 'Chariot',
    abbr: 'R',
    pinyin: { [RED]: 'jū', [BLACK]: 'jū' },
    value: 9,
  },
  [CANNON]: {
    type: CANNON,
    glyph: { [RED]: '炮', [BLACK]: '炮' },
    en: 'Cannon',
    abbr: 'C',
    pinyin: { [RED]: 'pào', [BLACK]: 'pào' },
    value: 4.5,
  },
  [SOLDIER]: {
    type: SOLDIER,
    glyph: { [RED]: '兵', [BLACK]: '卒' },
    en: 'Soldier',
    abbr: 'S',
    pinyin: { [RED]: 'bīng', [BLACK]: 'zú' },
    value: 1,
  },
};

export const infoOf = (piece: Piece): PieceInfo => PIECE_INFO[typeOf(piece)];

export const glyphOf = (piece: Piece): string => infoOf(piece).glyph[colorOf(piece)];

/**
 * The floating hover label. English mode leads with the English name and keeps
 * the character as a subtitle so players learn to read the board.
 */
export const hoverLabel = (piece: Piece, lang: Lang): { title: string; subtitle: string } => {
  const info = infoOf(piece);
  const color = colorOf(piece);
  const glyph = info.glyph[color];
  const sideZh = color === RED ? '红' : '黑';
  const sideEn = color === RED ? 'Red' : 'Black';
  return lang === 'en'
    ? { title: `${sideEn} ${info.en}`, subtitle: `${glyph} · ${info.pinyin[color]}` }
    : { title: `${sideZh}${glyph}`, subtitle: info.en };
};

export const colorName = (color: Color, lang: Lang): string =>
  lang === 'en' ? (color === RED ? 'Red' : 'Black') : color === RED ? '红方' : '黑方';
