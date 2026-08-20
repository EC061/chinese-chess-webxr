/**
 * Board and piece textures, drawn with the 2D canvas API at load time.
 *
 * Drawing rather than shipping images has one decisive advantage here: the piece
 * faces are 汉字, and the alternative is bundling a CJK font (several megabytes
 * even subset) or accepting fallback boxes. Canvas uses the system font, which
 * every headset browser has, and the result is sharper than a baked atlas
 * because each glyph is rendered at texture resolution.
 */
import {
  BLACK, RED, colorOf, glyphOf, infoOf, typeOf, type Piece,
} from '@ccx/shared';
import { CanvasTexture, LinearFilter, SRGBColorSpace, type Texture } from 'three';

const CJK_SERIF = "'Songti SC','STSong','Source Han Serif SC','Noto Serif CJK SC','SimSun','MingLiU',serif";
const LATIN = "'Inter','Helvetica Neue',Arial,sans-serif";

export const PALETTE = {
  boardLight: '#e3bd85',
  boardDark: '#cf9f62',
  boardLine: '#4a3319',
  boardEdge: '#8a5f2c',
  ivory: '#f2e2c4',
  ivoryShade: '#d8c19a',
  red: '#a8231f',
  black: '#22201e',
  table: '#4d3524',
  felt: '#2f4a3a',
  highlight: '#3fbf6f',
  lastMove: '#e0a53a',
  danger: '#d94f3d',
  hint: '#4a9fd8',
} as const;

const canvas2d = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  return { canvas, ctx };
};

const finish = (canvas: HTMLCanvasElement, anisotropy = 8, flipY = true): Texture => {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.flipY = flipY;
  texture.needsUpdate = true;
  return texture;
};

// ----------------------------------------------------------------- the board --

const BOARD_PX = 1120;
const MARGIN_PX = 80;
const CELL_PX = (BOARD_PX - MARGIN_PX * 2) / 8;
const BOARD_PY = MARGIN_PX * 2 + CELL_PX * 9;

const px = (col: number, row: number): [number, number] =>
  [MARGIN_PX + col * CELL_PX, MARGIN_PX + row * CELL_PX];

let boardTexture: Texture | null = null;

/**
 * The playing surface. Note the two details that make a Xiangqi board read
 * correctly and that a chessboard has no equivalent of: the file lines stop at
 * the river except along the two outer edges, and the palaces carry diagonals.
 */
export const getBoardTexture = (): Texture => {
  if (boardTexture) return boardTexture;
  const { canvas, ctx } = canvas2d(BOARD_PX, BOARD_PY);

  const grain = ctx.createLinearGradient(0, 0, BOARD_PX, BOARD_PY);
  grain.addColorStop(0, PALETTE.boardLight);
  grain.addColorStop(0.5, '#dcb078');
  grain.addColorStop(1, PALETTE.boardDark);
  ctx.fillStyle = grain;
  ctx.fillRect(0, 0, BOARD_PX, BOARD_PY);

  // Faint wood grain: a few dozen low-contrast streaks along the long axis.
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = '#6b4520';
  for (let i = 0; i < 90; i++) {
    const y = Math.random() * BOARD_PY;
    ctx.lineWidth = 1 + Math.random() * 2.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= BOARD_PX; x += 40) {
      ctx.lineTo(x, y + Math.sin((x / BOARD_PX) * Math.PI * (1 + Math.random())) * 4);
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = PALETTE.boardLine;
  ctx.lineCap = 'round';

  const line = (a: [number, number], b: [number, number], width = 3) => {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  };

  // Ranks: ten unbroken horizontal lines.
  for (let row = 0; row < 10; row++) line(px(0, row), px(8, row));

  // Files: broken at the river, except the outer two which run the full length.
  for (let col = 0; col < 9; col++) {
    if (col === 0 || col === 8) {
      line(px(col, 0), px(col, 9));
    } else {
      line(px(col, 0), px(col, 4));
      line(px(col, 5), px(col, 9));
    }
  }

  // Border, drawn twice for the traditional double edge.
  ctx.lineWidth = 6;
  ctx.strokeRect(...px(0, 0), CELL_PX * 8, CELL_PX * 9);
  ctx.lineWidth = 2;
  const inset = 12;
  ctx.strokeRect(
    MARGIN_PX - inset, MARGIN_PX - inset,
    CELL_PX * 8 + inset * 2, CELL_PX * 9 + inset * 2,
  );

  // Palace diagonals.
  line(px(3, 0), px(5, 2));
  line(px(5, 0), px(3, 2));
  line(px(3, 7), px(5, 9));
  line(px(5, 7), px(3, 9));

  // 楚河 汉界 across the river.
  ctx.save();
  ctx.fillStyle = 'rgba(74,51,25,0.82)';
  ctx.font = `600 ${Math.round(CELL_PX * 0.62)}px ${CJK_SERIF}`;
  ctx.textBaseline = 'middle';
  const riverY = (px(0, 4)[1] + px(0, 5)[1]) / 2;
  ctx.textAlign = 'left';
  ctx.fillText('楚 河', px(1, 0)[0], riverY);
  ctx.textAlign = 'right';
  ctx.fillText('汉 界', px(7, 0)[0], riverY);
  ctx.restore();

  // Corner ticks marking the soldier and cannon points, as on a printed board.
  const tick = CELL_PX * 0.18;
  const gap = CELL_PX * 0.1;
  const marks: Array<[number, number]> = [
    [1, 2], [7, 2], [1, 7], [7, 7],
    [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
    [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
  ];
  ctx.lineWidth = 2.5;
  for (const [col, row] of marks) {
    const [x, y] = px(col, row);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        if (col === 0 && sx === -1) continue;
        if (col === 8 && sx === 1) continue;
        ctx.beginPath();
        ctx.moveTo(x + sx * gap, y + sy * (gap + tick));
        ctx.lineTo(x + sx * gap, y + sy * gap);
        ctx.lineTo(x + sx * (gap + tick), y + sy * gap);
        ctx.stroke();
      }
    }
  }

  boardTexture = finish(canvas, 16);
  return boardTexture;
};

export const BOARD_TEXTURE_ASPECT = BOARD_PX / BOARD_PY;

// ----------------------------------------------------------------- the pieces --

const PIECE_PX = 320;
const pieceCache = new Map<string, Texture>();

/**
 * A piece face: turned wood disc, an engraved ring in the side's colour, and the
 * character. `labels: 'both'` adds the Latin abbreviation underneath, which is
 * what makes the board readable to someone who has not learned the characters
 * yet without replacing them.
 *
 * Black's characters are drawn rotated 180°, so each side reads its own pieces
 * upright and the opponent's upside down — exactly like a real set across a real
 * table, and a useful second cue for whose piece is whose.
 *
 * The face is applied to a flat disc rather than a cylinder cap: a cylinder's
 * cap UVs run `u` along +Z and `v` along +X, which is a reflection of the
 * mapping you want and silently mirrors every character.
 */
export const getPieceTexture = (piece: Piece, labels: 'zh' | 'both'): Texture => {
  const key = `${piece}:${labels}`;
  const cached = pieceCache.get(key);
  if (cached) return cached;

  const { canvas, ctx } = canvas2d(PIECE_PX, PIECE_PX);
  const c = PIECE_PX / 2;
  const isRed = colorOf(piece) === RED;
  const ink = isRed ? PALETTE.red : PALETTE.black;

  if (!isRed) {
    // Turn Black's face to point at Black's seat.
    ctx.translate(c, c);
    ctx.rotate(Math.PI);
    ctx.translate(-c, -c);
  }

  const face = ctx.createRadialGradient(c * 0.75, c * 0.7, c * 0.15, c, c, c);
  face.addColorStop(0, '#fbf1de');
  face.addColorStop(0.62, PALETTE.ivory);
  face.addColorStop(1, PALETTE.ivoryShade);
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(c, c, c - 2, 0, Math.PI * 2);
  ctx.fill();

  // Engraved ring.
  ctx.strokeStyle = ink;
  ctx.lineWidth = PIECE_PX * 0.028;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = PIECE_PX * 0.012;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.88, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;

  const glyph = glyphOf(piece);
  const both = labels === 'both';
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(PIECE_PX * (both ? 0.46 : 0.54))}px ${CJK_SERIF}`;
  ctx.fillText(glyph, c, both ? c * 0.9 : c * 1.02);

  if (both) {
    ctx.font = `600 ${Math.round(PIECE_PX * 0.13)}px ${LATIN}`;
    ctx.globalAlpha = 0.75;
    ctx.fillText(infoOf(piece).en.toUpperCase(), c, c * 1.46);
    ctx.globalAlpha = 1;
  }

  const texture = finish(canvas);
  pieceCache.set(key, texture);
  return texture;
};

/** Warm wood for the piece edge, so the rim does not read as flat plastic. */
let edgeTexture: Texture | null = null;
export const getPieceEdgeTexture = (): Texture => {
  if (edgeTexture) return edgeTexture;
  const { canvas, ctx } = canvas2d(64, 16);
  const gradient = ctx.createLinearGradient(0, 0, 0, 16);
  gradient.addColorStop(0, PALETTE.ivoryShade);
  gradient.addColorStop(0.5, '#c9ac82');
  gradient.addColorStop(1, '#b3956a');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 16);
  edgeTexture = finish(canvas, 4);
  return edgeTexture;
};

// -------------------------------------------------------------------- UI text --

interface TextOptions {
  size?: number;
  color?: string;
  weight?: number;
  align?: CanvasTextAlign;
  font?: 'cjk' | 'latin';
  maxWidth?: number;
  lineHeight?: number;
  background?: string;
  padding?: number;
  radius?: number;
}

export interface TextTexture {
  texture: Texture;
  /** width / height, for sizing the plane that shows it. */
  aspect: number;
}

const textCache = new Map<string, TextTexture>();
const TEXT_CACHE_LIMIT = 400;

const wrap = (
  ctx: CanvasRenderingContext2D, text: string, maxWidth: number, cjk: boolean,
): string[] => {
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) { lines.push(''); continue; }
    // Chinese has no spaces, so wrap per character; Latin wraps per word.
    const units = cjk ? [...paragraph] : paragraph.split(/(\s+)/);
    let current = '';
    for (const unit of units) {
      const candidate = current + unit;
      if (ctx.measureText(candidate).width > maxWidth && current) {
        lines.push(current.trimEnd());
        current = unit.trimStart();
      } else {
        current = candidate;
      }
    }
    if (current.trim()) lines.push(current.trimEnd());
  }
  return lines.length ? lines : [''];
};

/**
 * Render a string to a texture, cached. Used for every label in the 3D UI: it
 * handles both scripts through the system font and stays crisp because the
 * canvas is sized to the text rather than the text scaled to a fixed canvas.
 */
export const getTextTexture = (text: string, options: TextOptions = {}): TextTexture => {
  const {
    size = 44, color = '#f4ece0', weight = 500, align = 'left', font = 'cjk',
    maxWidth = 1400, lineHeight = 1.35, background, padding = 0, radius = 0,
  } = options;

  const key = JSON.stringify([text, size, color, weight, align, font, maxWidth, lineHeight, background, padding, radius]);
  const cached = textCache.get(key);
  if (cached) return cached;

  const family = font === 'cjk' ? `${LATIN.replace(/,$/, '')},${CJK_SERIF}` : LATIN;
  const measure = canvas2d(8, 8).ctx;
  measure.font = `${weight} ${size}px ${family}`;
  const lines = wrap(measure, text, maxWidth, /[㐀-鿿]/.test(text));
  const widest = Math.max(1, ...lines.map((l) => measure.measureText(l).width));

  const lineStep = size * lineHeight;
  const width = Math.ceil(widest + padding * 2);
  const height = Math.ceil(lines.length * lineStep + padding * 2);
  const { canvas, ctx } = canvas2d(Math.min(2048, width), Math.min(2048, height));

  if (background) {
    ctx.fillStyle = background;
    if (radius > 0) {
      ctx.beginPath();
      ctx.roundRect(0, 0, canvas.width, canvas.height, radius);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  ctx.font = `${weight} ${size}px ${family}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = align;
  const x = align === 'center' ? canvas.width / 2 : align === 'right' ? canvas.width - padding : padding;
  lines.forEach((l, i) => ctx.fillText(l, x, padding + lineStep * (i + 0.5)));

  const result: TextTexture = { texture: finish(canvas), aspect: canvas.width / canvas.height };

  if (textCache.size > TEXT_CACHE_LIMIT) {
    // Simple FIFO eviction: labels are cheap to redraw and this keeps GPU
    // memory bounded on a headset.
    const oldest = textCache.keys().next().value;
    if (oldest !== undefined) {
      textCache.get(oldest)?.texture.dispose();
      textCache.delete(oldest);
    }
  }
  textCache.set(key, result);
  return result;
};
