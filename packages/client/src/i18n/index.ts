/**
 * Interface strings. Chinese is the source language — this is 中国象棋 — and
 * English is a full peer, because the piece names and the tutorial are the
 * whole point of the English mode.
 */
export type Lang = 'zh' | 'en';

export interface Strings {
  appTitle: string;
  appSubtitle: string;
  enterVr: string;
  enterAr: string;
  exitVr: string;
  vrUnsupported: string;
  vrChecking: string;
  flatModeHint: string;

  // auth
  signIn: string;
  signUp: string;
  playAsGuest: string;
  displayName: string;
  password: string;
  passwordHint: string;
  signOut: string;
  guestNotice: string;
  authFailed: string;

  // menu
  playAi: string;
  playAiSub: string;
  playHuman: string;
  playHumanSub: string;
  tutorial: string;
  tutorialSub: string;
  leaderboard: string;
  settings: string;
  back: string;
  close: string;

  // ai setup
  difficulty: string;
  yourSide: string;
  red: string;
  black: string;
  randomSide: string;
  startGame: string;
  aiStrength: string;
  aiThinking: string;
  threads: string;
  singleThreadNotice: string;

  // lobby
  rooms: string;
  refresh: string;
  createRoom: string;
  roomName: string;
  passcodeOptional: string;
  passcodeLabel: string;
  ratedGame: string;
  allowSpectators: string;
  timeControl: string;
  untimed: string;
  join: string;
  spectate: string;
  noRooms: string;
  waiting: string;
  playing: string;
  finished: string;
  locked: string;
  spectators: string;
  waitingForOpponent: string;
  roomCode: string;
  enterPasscode: string;
  wrongPasscode: string;
  leaveRoom: string;

  // game
  yourTurn: string;
  opponentTurn: string;
  check: string;
  checkmate: string;
  stalemate: string;
  youWin: string;
  youLose: string;
  draw: string;
  undo: string;
  undoRequested: string;
  undoAsk: string;
  undoAccepted: string;
  undoDeclined: string;
  accept: string;
  decline: string;
  resign: string;
  offerDraw: string;
  drawOffered: string;
  rematch: string;
  waitingRematch: string;
  moveList: string;
  captured: string;
  ratingChange: string;
  unratedBecauseUndo: string;
  hint: string;
  recenter: string;
  passthrough: string;

  // reasons
  reasonCheckmate: string;
  reasonStalemate: string;
  reasonRepetition: string;
  reasonNoCapture: string;
  reasonMaterial: string;
  reasonResignation: string;
  reasonTimeout: string;
  reasonAbandoned: string;
  reasonAgreement: string;

  // tutorial
  lessons: string;
  rules: string;
  tryIt: string;
  nextDemo: string;
  prevDemo: string;
  correct: string;
  tryAgain: string;
  showMoves: string;
  tutorialIntro: string;
  blockedBy: string;

  // settings
  language: string;
  pieceLabels: string;
  pieceLabelsZh: string;
  pieceLabelsBoth: string;
  soundOn: string;
  handedness: string;
  boardScale: string;
  connectionLost: string;
  reconnecting: string;
}

const zh: Strings = {
  appTitle: '中国象棋',
  appSubtitle: 'WebXR · 隔桌对弈',
  enterVr: '进入 VR',
  enterAr: '透视模式',
  exitVr: '退出 VR',
  vrUnsupported: '此浏览器不支持 VR。你仍然可以在屏幕上下棋。',
  vrChecking: '正在检测头显…',
  flatModeHint: '鼠标拖动可旋转视角；点击棋子选中，再点目标点落子。',

  signIn: '登录',
  signUp: '注册',
  playAsGuest: '以访客身份进入',
  displayName: '昵称',
  password: '密码',
  passwordHint: '至少 8 个字符',
  signOut: '退出登录',
  guestNotice: '访客对局不计积分。注册后即可累积棋力评分。',
  authFailed: '登录失败',

  playAi: '人机对战',
  playAiSub: '八档棋力，可随时悔棋',
  playHuman: '联机对战',
  playHumanSub: '加入房间，或开一间带密码的房',
  tutorial: '教学模式',
  tutorialSub: '每种棋子怎么走，逐个讲清楚',
  leaderboard: '排行榜',
  settings: '设置',
  back: '返回',
  close: '关闭',

  difficulty: '难度',
  yourSide: '执子',
  red: '红方',
  black: '黑方',
  randomSide: '随机',
  startGame: '开始对局',
  aiStrength: '约',
  aiThinking: '思考中',
  threads: '搜索线程',
  singleThreadNotice: '当前为单线程搜索（需要跨源隔离才能多线程）。',

  rooms: '房间列表',
  refresh: '刷新',
  createRoom: '创建房间',
  roomName: '房间名',
  passcodeOptional: '密码（可留空）',
  passcodeLabel: '密码',
  ratedGame: '计入积分',
  allowSpectators: '允许旁观',
  timeControl: '用时',
  untimed: '不限时',
  join: '加入',
  spectate: '旁观',
  noRooms: '还没有房间。开一间吧。',
  waiting: '等待对手',
  playing: '对局中',
  finished: '已结束',
  locked: '需要密码',
  spectators: '旁观',
  waitingForOpponent: '等待对手加入…',
  roomCode: '房间号',
  enterPasscode: '输入房间密码',
  wrongPasscode: '密码不对',
  leaveRoom: '离开房间',

  yourTurn: '该你走',
  opponentTurn: '等对手走',
  check: '将军',
  checkmate: '将死',
  stalemate: '困毙',
  youWin: '你赢了',
  youLose: '你输了',
  draw: '和棋',
  undo: '悔棋',
  undoRequested: '已请求悔棋，等对方同意…',
  undoAsk: '对方请求悔棋',
  undoAccepted: '对方同意悔棋',
  undoDeclined: '对方不同意悔棋',
  accept: '同意',
  decline: '不同意',
  resign: '认输',
  offerDraw: '求和',
  drawOffered: '对方求和',
  rematch: '再来一局',
  waitingRematch: '等对方同意再来一局…',
  moveList: '棋谱',
  captured: '被吃',
  ratingChange: '积分变化',
  unratedBecauseUndo: '本局因悔棋不计积分',
  hint: '提示',
  recenter: '重新对位',
  passthrough: '透视',

  reasonCheckmate: '将死',
  reasonStalemate: '无棋可走',
  reasonRepetition: '循环重复',
  reasonNoCapture: '六十回合无吃子',
  reasonMaterial: '子力不足',
  reasonResignation: '认输',
  reasonTimeout: '超时',
  reasonAbandoned: '掉线',
  reasonAgreement: '双方同意',

  lessons: '棋子',
  rules: '规则',
  tryIt: '练一手',
  nextDemo: '下一例',
  prevDemo: '上一例',
  correct: '对了',
  tryAgain: '再想想',
  showMoves: '显示走法',
  tutorialIntro: '选一种棋子，看它怎么走。棋盘上的绿点是真正算出来的合法落点。',
  blockedBy: '被挡住',

  language: '语言',
  pieceLabels: '棋子标注',
  pieceLabelsZh: '只用汉字',
  pieceLabelsBoth: '汉字 + 英文缩写',
  soundOn: '音效',
  handedness: '主手',
  boardScale: '棋盘大小',
  connectionLost: '连接已断开',
  reconnecting: '正在重连…',
};

const en: Strings = {
  appTitle: 'Chinese Chess',
  appSubtitle: 'Xiangqi in WebXR · across a table',
  enterVr: 'Enter VR',
  enterAr: 'Passthrough',
  exitVr: 'Leave VR',
  vrUnsupported: 'This browser has no VR support. You can still play on screen.',
  vrChecking: 'Looking for a headset…',
  flatModeHint: 'Drag to orbit. Click a piece to pick it up, then click a marker to place it.',

  signIn: 'Sign in',
  signUp: 'Create account',
  playAsGuest: 'Play as guest',
  displayName: 'Display name',
  password: 'Password',
  passwordHint: 'At least 8 characters',
  signOut: 'Sign out',
  guestNotice: 'Guest games are not rated. Create an account to build a rating.',
  authFailed: 'Sign-in failed',

  playAi: 'Play the AI',
  playAiSub: 'Eight strength levels, take back moves freely',
  playHuman: 'Play a person',
  playHumanSub: 'Join a room, or open one behind a passcode',
  tutorial: 'Learn the pieces',
  tutorialSub: 'How every piece moves, one at a time',
  leaderboard: 'Ratings',
  settings: 'Settings',
  back: 'Back',
  close: 'Close',

  difficulty: 'Difficulty',
  yourSide: 'Your side',
  red: 'Red',
  black: 'Black',
  randomSide: 'Random',
  startGame: 'Start game',
  aiStrength: 'about',
  aiThinking: 'Thinking',
  threads: 'Search threads',
  singleThreadNotice: 'Searching on one thread — multi-threading needs cross-origin isolation.',

  rooms: 'Rooms',
  refresh: 'Refresh',
  createRoom: 'Create a room',
  roomName: 'Room name',
  passcodeOptional: 'Passcode (optional)',
  passcodeLabel: 'Passcode',
  ratedGame: 'Rated',
  allowSpectators: 'Allow spectators',
  timeControl: 'Clock',
  untimed: 'No clock',
  join: 'Join',
  spectate: 'Watch',
  noRooms: 'No rooms yet. Open one.',
  waiting: 'Waiting for an opponent',
  playing: 'In progress',
  finished: 'Finished',
  locked: 'Passcode',
  spectators: 'watching',
  waitingForOpponent: 'Waiting for an opponent…',
  roomCode: 'Room code',
  enterPasscode: 'Enter the room passcode',
  wrongPasscode: 'Wrong passcode',
  leaveRoom: 'Leave room',

  yourTurn: 'Your move',
  opponentTurn: 'Opponent to move',
  check: 'Check',
  checkmate: 'Checkmate',
  stalemate: 'No legal moves',
  youWin: 'You win',
  youLose: 'You lose',
  draw: 'Draw',
  undo: 'Take back',
  undoRequested: 'Asked to take back — waiting for your opponent…',
  undoAsk: 'Your opponent asks to take back a move',
  undoAccepted: 'Take-back accepted',
  undoDeclined: 'Take-back declined',
  accept: 'Allow',
  decline: 'Refuse',
  resign: 'Resign',
  offerDraw: 'Offer a draw',
  drawOffered: 'Your opponent offers a draw',
  rematch: 'Play again',
  waitingRematch: 'Waiting for your opponent to agree…',
  moveList: 'Moves',
  captured: 'Captured',
  ratingChange: 'Rating',
  unratedBecauseUndo: 'Unrated — a move was taken back',
  hint: 'Hint',
  recenter: 'Recentre',
  passthrough: 'Passthrough',

  reasonCheckmate: 'checkmate',
  reasonStalemate: 'no legal moves',
  reasonRepetition: 'repetition',
  reasonNoCapture: '60 moves without a capture',
  reasonMaterial: 'not enough material',
  reasonResignation: 'resignation',
  reasonTimeout: 'the clock',
  reasonAbandoned: 'disconnection',
  reasonAgreement: 'agreement',

  lessons: 'Pieces',
  rules: 'Rules',
  tryIt: 'Try it',
  nextDemo: 'Next example',
  prevDemo: 'Previous',
  correct: 'That is it',
  tryAgain: 'Not quite',
  showMoves: 'Show moves',
  tutorialIntro:
    'Pick a piece to see how it moves. The green dots come from the real rules engine, not a drawing.',
  blockedBy: 'blocked',

  language: 'Language',
  pieceLabels: 'Piece labels',
  pieceLabelsZh: 'Characters only',
  pieceLabelsBoth: 'Characters + Latin',
  soundOn: 'Sound',
  handedness: 'Main hand',
  boardScale: 'Board size',
  connectionLost: 'Connection lost',
  reconnecting: 'Reconnecting…',
};

export const STRINGS: Record<Lang, Strings> = { zh, en };

export const reasonText = (reason: string, s: Strings): string => {
  switch (reason) {
    case 'checkmate': return s.reasonCheckmate;
    case 'stalemate': return s.reasonStalemate;
    case 'repetition': return s.reasonRepetition;
    case 'no-capture-limit': return s.reasonNoCapture;
    case 'insufficient-material': return s.reasonMaterial;
    case 'resignation': return s.reasonResignation;
    case 'timeout': return s.reasonTimeout;
    case 'abandoned': return s.reasonAbandoned;
    case 'agreement': return s.reasonAgreement;
    default: return reason;
  }
};

/** Best-guess starting language from the browser, defaulting to Chinese. */
export const detectLang = (): Lang => {
  if (typeof navigator === 'undefined') return 'zh';
  const stored = localStorage.getItem('ccx.lang');
  if (stored === 'zh' || stored === 'en') return stored;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
};
