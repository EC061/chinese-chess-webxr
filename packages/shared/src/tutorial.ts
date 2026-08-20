/**
 * 教学模式 content. Every demo is a real position run through the real rules
 * engine — the highlighted dots come from `Position.legalTargets`, so the
 * tutorial can never drift out of sync with how the game actually plays.
 *
 * Both generals appear on every demo board, because legality is defined
 * relative to them; they are parked on different files so they never interfere
 * unless the lesson is specifically about 飞将.
 */
import { buildFen, type Placement } from './fen.js';
import {
  ADVISOR, CANNON, CHARIOT, ELEPHANT, GENERAL, HORSE, SOLDIER, idx, type PieceType,
} from './types.js';

export interface Bilingual {
  zh: string;
  en: string;
}

export interface TutorialDemo {
  /** What this board is teaching. */
  caption: Bilingual;
  fen: string;
  /** Square whose legal moves get highlighted. */
  focus: number;
  /** Squares to ring in amber as "this is the thing in the way". */
  obstacles?: number[];
  /** Extra note shown under the board while this demo is on screen. */
  note?: Bilingual;
}

export interface TutorialChallenge {
  prompt: Bilingual;
  fen: string;
  /** ICCS coordinates of every accepted answer. */
  solutions: string[];
  success: Bilingual;
}

export interface TutorialLesson {
  id: string;
  type: PieceType;
  title: Bilingual;
  summary: Bilingual;
  rules: Bilingual[];
  demos: TutorialDemo[];
  challenge: TutorialChallenge;
}

const at = (ch: string, row: number, col: number): Placement => [ch, row, col];
const sq = (row: number, col: number) => idx(row, col);

/** Generals on files d and f, where they can never face each other. */
const IDLE: Placement[] = [at('K', 9, 3), at('k', 0, 5)];
/** Red general on the middle file, for lessons where the palace itself matters. */
const IDLE_CENTRE: Placement[] = [at('K', 9, 4), at('k', 0, 5)];

export const LESSONS: TutorialLesson[] = [
  {
    id: 'general',
    type: GENERAL,
    title: { zh: '帅 / 将', en: 'The General' },
    summary: {
      zh: '一步一格，走不出九宫；两帅不可照面。',
      en: 'One step at a time inside the palace — and the two generals may never see each other.',
    },
    rules: [
      { zh: '每步只走一格，直上直下或左右平移，不走斜线。',
        en: 'Moves exactly one square per turn — up, down, left or right, never diagonally.' },
      { zh: '只能在九宫（三乘三的方格）内活动，共九个落点。',
        en: 'Confined to the 3×3 palace, so it only ever has nine squares to stand on.' },
      { zh: '飞将：两方帅将不能在同一直线上直接照面，中间必须有子。走出这种局面的那一步就是违规。',
        en: 'Flying general: the two generals may never face each other down an open file. Any move that would expose them is illegal.' },
      { zh: '被将死或无棋可走即败——象棋没有「和棋逼和」这一说。',
        en: 'Losing the general, or having no legal move at all, loses the game — unlike western chess, stalemate is a loss.' },
    ],
    demos: [
      {
        caption: { zh: '九宫正中，四个方向各一格', en: 'From the palace centre: one step in each of four directions' },
        fen: buildFen([at('K', 8, 4), at('k', 0, 4), at('b', 2, 4)]),
        focus: sq(8, 4),
      },
      {
        caption: { zh: '走到宫角，落点只剩两个', en: 'In a palace corner only two squares remain' },
        fen: buildFen([at('K', 9, 3), at('k', 0, 5)]),
        focus: sq(9, 3),
      },
      {
        caption: { zh: '飞将：这只车被钉在中线上', en: 'Flying general: this chariot is pinned to the file' },
        fen: buildFen([at('K', 9, 4), at('k', 0, 4), at('R', 7, 4)]),
        focus: sq(7, 4),
        obstacles: [sq(9, 4), sq(0, 4)],
        note: {
          zh: '两帅同在中线，中间只隔这只车。车一旦平移，两帅照面，所以所有横走都是违规的。',
          en: 'Both generals sit on the middle file with only this chariot between them. Step it sideways and they would face each other, so every sideways move is illegal.',
        },
      },
    ],
    challenge: {
      prompt: { zh: '红帅被黑车将着。动帅避将。', en: 'The black chariot has Red in check. Step the general out of the line.' },
      fen: buildFen([at('K', 9, 4), at('k', 0, 4), at('r', 5, 4)]),
      solutions: ['e0d0', 'e0f0'],
      success: {
        zh: '对了。离开中线，车的射线就落空了。',
        en: 'Correct — off the file, the chariot’s line of attack hits nothing.',
      },
    },
  },
  {
    id: 'advisor',
    type: ADVISOR,
    title: { zh: '仕 / 士', en: 'The Advisor' },
    summary: {
      zh: '斜走一格，不出九宫，全局只有五个落点。',
      en: 'One diagonal step, never leaving the palace — only five squares in the whole game.',
    },
    rules: [
      { zh: '每步斜走一格。', en: 'Moves exactly one square diagonally.' },
      { zh: '不出九宫，因此只有五个可站的点：四角加正中。',
        en: 'Cannot leave the palace, which leaves exactly five reachable points: four corners and the centre.' },
      { zh: '作用是护帅，尤其是挡对方的车和炮；缺士的局面很怕双车。',
        en: 'Purely defensive — it shields the general, especially from chariots and cannons. A general missing its advisors is badly exposed.' },
    ],
    demos: [
      {
        caption: { zh: '仕居中，四角皆可去', en: 'From the centre it reaches all four corners' },
        fen: buildFen([at('A', 8, 4), ...IDLE_CENTRE]),
        focus: sq(8, 4),
      },
      {
        caption: { zh: '在角上，只能回到正中', en: 'From a corner the only move is back to the centre' },
        fen: buildFen([at('A', 9, 5), ...IDLE_CENTRE]),
        focus: sq(9, 5),
      },
    ],
    challenge: {
      prompt: { zh: '黑炮隔着红马打帅。上仕解将。', en: 'The black cannon is firing over the horse at your general. Block with the advisor.' },
      fen: buildFen([at('K', 9, 4), at('k', 0, 3), at('c', 0, 4), at('A', 9, 5), at('N', 5, 4)]),
      solutions: ['f0e1'],
      success: {
        zh: '中线上多了一个子，炮架就变成两个——炮打不动了。',
        en: 'Now two pieces stand in the way instead of one, and a cannon needs exactly one. The check is gone.',
      },
    },
  },
  {
    id: 'elephant',
    type: ELEPHANT,
    title: { zh: '相 / 象', en: 'The Elephant' },
    summary: {
      zh: '走田字，塞象眼就走不通，而且永不过河。',
      en: 'Two squares diagonally, blocked at the midpoint, and it can never cross the river.',
    },
    rules: [
      { zh: '走「田」字：斜向走两格。', en: 'Moves two points diagonally — the shape of the character 田.' },
      { zh: '田字的中心叫「象眼」，有任何子塞在那里，这个方向就走不通。',
        en: 'The midpoint is the "elephant’s eye". Any piece sitting there blocks that move.' },
      { zh: '不能过河，所以全局只有七个落点，是纯防守的子。',
        en: 'It may never cross the river, so it only ever has seven squares — a purely defensive piece.' },
    ],
    demos: [
      {
        caption: { zh: '相在原位，可走两处', en: 'From its starting point: two destinations' },
        fen: buildFen([at('B', 9, 2), ...IDLE]),
        focus: sq(9, 2),
      },
      {
        caption: { zh: '河沿上的相：向前的两条路作废', en: 'On the riverbank, both forward paths are void' },
        fen: buildFen([at('B', 5, 4), ...IDLE]),
        focus: sq(5, 4),
        note: {
          zh: '往前的两个田字都要过河，所以不算落点，只剩后方两处。',
          en: 'Both forward diagonals would land across the river, so they do not count. Only the two rearward squares remain.',
        },
      },
      {
        caption: { zh: '塞象眼', en: 'A blocked elephant’s eye' },
        fen: buildFen([at('B', 7, 4), at('P', 8, 3), ...IDLE]),
        focus: sq(7, 4),
        obstacles: [sq(8, 3)],
        note: {
          zh: '兵正好停在象眼上，那个方向就被封死——自己的子和敌人的子一样塞。',
          en: 'The soldier sits exactly on the eye, sealing that direction. Your own pieces block it just as well as the enemy’s.',
        },
      },
    ],
    challenge: {
      prompt: { zh: '走相吃掉黑卒。', en: 'Capture the black soldier with your elephant.' },
      fen: buildFen([at('B', 7, 2), at('p', 9, 0), ...IDLE]),
      solutions: ['c2a0'],
      success: { zh: '一个完整的田字，吃子。', en: 'One full 田 step, and the soldier is gone.' },
    },
  },
  {
    id: 'horse',
    type: HORSE,
    title: { zh: '马', en: 'The Horse' },
    summary: {
      zh: '走日字，但会被「别马腿」——旁边有子就跳不过去。',
      en: 'Moves like a knight, but a piece directly beside it blocks the leap.',
    },
    rules: [
      { zh: '走「日」字：先直行一格，再斜行一格。',
        en: 'One square straight, then one diagonally outward — the shape of the character 日.' },
      { zh: '第一格若有子，叫「别马腿」，这个方向不能走。这是与国际象棋最大的区别：象棋的马可以被拦住。',
        en: 'If that first straight square is occupied the leap is blocked — "hobbling the horse’s leg". This is the big difference from the western knight, which cannot be blocked.' },
      { zh: '马在开阔的局面最强，被围住时价值大跌。',
        en: 'Strongest on an open board; nearly worthless when hemmed in.' },
    ],
    demos: [
      {
        caption: { zh: '空地上的马，八个方向', en: 'On an open board: eight destinations' },
        fen: buildFen([at('N', 5, 4), ...IDLE]),
        focus: sq(5, 4),
      },
      {
        caption: { zh: '别马腿：前方一个子，废掉两路', en: 'Hobbled: one piece ahead removes two of the eight' },
        fen: buildFen([at('N', 5, 4), at('P', 4, 4), ...IDLE]),
        focus: sq(5, 4),
        obstacles: [sq(4, 4)],
        note: {
          zh: '兵挡在马的正前方，向前的两个日字全部作废，只剩六路。',
          en: 'The soldier stands directly in front, cancelling both forward leaps. Six moves remain.',
        },
      },
      {
        caption: { zh: '三面被塞，马几乎动不了', en: 'Hobbled on three sides, the horse is nearly frozen' },
        fen: buildFen([at('N', 5, 4), at('P', 4, 4), at('P', 6, 4), at('P', 5, 3), ...IDLE]),
        focus: sq(5, 4),
        obstacles: [sq(4, 4), sq(6, 4), sq(5, 3)],
      },
    ],
    challenge: {
      prompt: { zh: '马吃车。先看清哪条腿被别住了。', en: 'Take the chariot with your horse — first work out which leg is blocked.' },
      fen: buildFen([at('N', 5, 4), at('P', 4, 4), at('r', 4, 2), ...IDLE]),
      solutions: ['e4c5'],
      success: {
        zh: '向前的路被别住，先横一步再斜出去，同样吃到车。',
        en: 'The forward leaps were blocked, but going sideways-then-out reaches the chariot all the same.',
      },
    },
  },
  {
    id: 'chariot',
    type: CHARIOT,
    title: { zh: '车', en: 'The Chariot' },
    summary: {
      zh: '直线任意远，不能拐弯，也不能越子——最强的子。',
      en: 'Any distance in a straight line: no turning, no jumping. The strongest piece on the board.',
    },
    rules: [
      { zh: '沿直线走任意格数，横竖都行，和国际象棋的车一样。',
        en: 'Slides any number of squares along a rank or file — identical to the western rook.' },
      { zh: '路上不能有子；第一个碰到的敌子可以吃掉。',
        en: 'The path must be clear; the first enemy piece it meets can be captured.' },
      { zh: '价值约等于两个马或两个炮，所以开局要尽早出车。',
        en: 'Worth roughly two horses or two cannons, so getting it into play early matters.' },
    ],
    demos: [
      {
        caption: { zh: '空车控制整条横线和竖线', en: 'An unobstructed chariot owns its whole rank and file' },
        fen: buildFen([at('R', 5, 4), ...IDLE]),
        focus: sq(5, 4),
      },
      {
        caption: { zh: '自己的子挡路，敌子可吃', en: 'Own pieces block; enemy pieces can be taken' },
        fen: buildFen([at('R', 5, 4), at('P', 5, 6), at('p', 2, 4), ...IDLE]),
        focus: sq(5, 4),
        obstacles: [sq(5, 6)],
        note: {
          zh: '向右走到自己的兵前就停；向前可以一直走到黑卒并吃掉它，但不能再往前。',
          en: 'It stops short of its own soldier, and runs up the file to capture the black soldier — but no further.',
        },
      },
    ],
    challenge: {
      prompt: { zh: '一步将死黑将。', en: 'Deliver mate in one.' },
      fen: buildFen([at('K', 9, 4), at('R', 5, 0), at('k', 0, 4), at('b', 1, 4)]),
      solutions: ['a4a9'],
      success: {
        zh: '车上底线，黑将左右都在车的射程内，正前方又被自己的象占住——将死。',
        en: 'The chariot takes the back rank. Both sideways squares are covered and the general’s own elephant blocks the third. Mate.',
      },
    },
  },
  {
    id: 'cannon',
    type: CANNON,
    title: { zh: '炮', en: 'The Cannon' },
    summary: {
      zh: '走的时候像车，吃子必须隔一个「炮架」。',
      en: 'Moves like a chariot, but to capture it must jump exactly one piece — the screen.',
    },
    rules: [
      { zh: '不吃子时，走法与车完全相同。', en: 'When not capturing, it moves exactly like a chariot.' },
      { zh: '吃子时，中间必须刚好隔着一个子，这个子叫「炮架」，敌我皆可；吃的是炮架后面的第一个敌子。',
        en: 'To capture, exactly one piece must stand between it and its target. That piece — friendly or enemy — is the screen.' },
      { zh: '隔零个不行，隔两个也不行，必须刚好一个。',
        en: 'Not zero pieces, not two — exactly one.' },
      { zh: '所以炮在满盘时最凶，残局子少了反而变弱；「炮不离楚河」是常见的封锁手法。',
        en: 'This makes the cannon fearsome on a crowded board and weaker in a bare endgame.' },
    ],
    demos: [
      {
        caption: { zh: '没有炮架，炮吃不到眼前的卒', en: 'With no screen, this cannon cannot take the soldier in front of it' },
        fen: buildFen([at('C', 5, 4), at('p', 2, 4), ...IDLE]),
        focus: sq(5, 4),
        obstacles: [sq(2, 4)],
        note: {
          zh: '黑卒就在正前方，但中间没有炮架，所以炮只能走到它前面，不能吃它。',
          en: 'The black soldier is right up the file, but with nothing to jump the cannon can only pull up in front of it.',
        },
      },
      {
        caption: { zh: '架上炮架，隔子打车', en: 'Give it a screen and it strikes right past' },
        fen: buildFen([at('C', 7, 4), at('N', 5, 4), at('r', 2, 4), ...IDLE]),
        focus: sq(7, 4),
        obstacles: [sq(5, 4)],
        note: {
          zh: '自己的马当炮架，炮就能越过它吃掉黑车。注意马后面的空格不再是落点。',
          en: 'Its own horse is the screen, so the cannon reaches over it to take the chariot. Note the empty squares beyond the screen are no longer destinations.',
        },
      },
    ],
    challenge: {
      prompt: { zh: '用炮吃掉黑车。', en: 'Capture the black chariot with the cannon.' },
      fen: buildFen([at('C', 9, 4), at('A', 8, 4), at('r', 4, 4), ...IDLE]),
      solutions: ['e0e5'],
      success: {
        zh: '仕正好是炮架，越过它吃车。',
        en: 'The advisor was the screen — the cannon jumps it and takes the chariot.',
      },
    },
  },
  {
    id: 'soldier',
    type: SOLDIER,
    title: { zh: '兵 / 卒', en: 'The Soldier' },
    summary: {
      zh: '向前一格；过河后才能左右平移，永不后退。',
      en: 'One step forward. After crossing the river it can also step sideways — but never back.',
    },
    rules: [
      { zh: '过河前只能直进一格。', en: 'Before the river: one step straight forward, nothing else.' },
      { zh: '过河后可以直进或左右平移一格，但仍然不能后退。',
        en: 'After the river: forward or one square sideways — still never backwards.' },
      { zh: '吃子和走法相同，没有斜吃。', en: 'It captures the same way it moves. There is no diagonal capture.' },
      { zh: '没有升变。走到底线的兵只能左右平移，俗称「老兵」。',
        en: 'There is no promotion. A soldier on the last rank can only shuffle sideways for the rest of the game.' },
    ],
    demos: [
      {
        caption: { zh: '过河前：只有一条路', en: 'Before the river: exactly one move' },
        fen: buildFen([at('P', 6, 4), ...IDLE]),
        focus: sq(6, 4),
      },
      {
        caption: { zh: '过河后：三条路', en: 'After the river: three moves' },
        fen: buildFen([at('P', 4, 4), ...IDLE]),
        focus: sq(4, 4),
        note: {
          zh: '过了河的兵战斗力大约翻倍，所以用兵去换取过河的机会往往是划算的。',
          en: 'A soldier across the river is worth roughly double, which is why trading to get one across usually pays.',
        },
      },
      {
        caption: { zh: '底线老兵：只能左右', en: 'On the last rank: sideways only' },
        fen: buildFen([at('P', 0, 4), at('k', 2, 5), at('K', 9, 4)]),
        focus: sq(0, 4),
      },
    ],
    challenge: {
      prompt: { zh: '用过了河的兵吃掉黑士。', en: 'Use your soldier across the river to take the advisor.' },
      fen: buildFen([at('P', 1, 4), at('a', 1, 3), at('k', 0, 5), at('K', 9, 4)]),
      solutions: ['e8d8'],
      success: {
        zh: '平移一格吃士——只有过了河的兵才有这一手。',
        en: 'A sideways step takes the advisor — a move only a soldier past the river can make.',
      },
    },
  },
];

export const lessonById = (id: string): TutorialLesson | undefined =>
  LESSONS.find((l) => l.id === id);
