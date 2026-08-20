/**
 * Application state. The store holds UI state and immutable board snapshots;
 * the live `Position` lives in {@link GameController}, which is the only thing
 * allowed to mutate it.
 */
import { create } from 'zustand';
import {
  BLACK, RED, type Clocks, type Emote, type PublicUser, type RoomSummary, type ServerMessage,
  type TimeControl, type Color,
} from '@ccx/shared';
import type { Engine } from '@ccx/ai';
import { STRINGS, detectLang, type Lang, type Strings } from '../i18n/index.js';
import { api, apiErrorText, loadToken, saveToken, type ApiUser, type ServerCapabilities } from './api.js';
import { createEngine, engineLabel } from './engine.js';
import { GameController, type Snapshot } from './gameController.js';
import { Net, type ConnectionState } from './net.js';
import { playSound, setSoundEnabled } from './sound.js';

export type Screen =
  | 'boot' | 'auth' | 'menu' | 'ai-setup' | 'lobby' | 'room' | 'tutorial'
  | 'leaderboard' | 'settings';

export interface Toast {
  text: string;
  kind: 'info' | 'warn' | 'good';
  at: number;
}

export interface Prompt {
  kind: 'undo' | 'draw';
  byName: string;
}

export interface Settings {
  pieceLabels: 'zh' | 'both';
  sound: boolean;
  boardScale: number;
  /** Preferred XR session mode when entering. */
  immersive: 'vr' | 'ar';
}

interface State {
  lang: Lang;
  s: Strings;
  screen: Screen;
  previousScreen: Screen;

  token: string | null;
  user: ApiUser | null;
  capabilities: ServerCapabilities | null;
  authBusy: boolean;
  authError: string | null;

  connection: ConnectionState;
  engineReady: boolean;
  engineInfo: string;

  snapshot: Snapshot;

  rooms: RoomSummary[];
  room: RoomSummary | null;
  seat: 'red' | 'black' | 'spectator' | null;
  clocks: Clocks | null;
  prompt: Prompt | null;
  awaitingUndoReply: boolean;
  rematchRequested: boolean;
  ratingDelta: { before: number; after: number } | null;
  peerEmote: { emote: Emote; at: number } | null;
  /** Head and hand poses of the other player, for their avatar. */
  peerPose: { head: number[]; hands: number[][] } | null;
  peerGrab: number | null;

  leaderboard: ApiUser[];
  toast: Toast | null;
  settings: Settings;
  /** Player-applied seat correction, so the board lands in front of them. */
  seatOffset: { x: number; z: number };
  recentreNonce: number;

  // actions
  boot(): Promise<void>;
  setLang(lang: Lang): void;
  goto(screen: Screen): void;
  updateSettings(patch: Partial<Settings>): void;

  signIn(name: string, password: string): Promise<boolean>;
  signUp(name: string, password: string): Promise<boolean>;
  playAsGuest(name: string): Promise<boolean>;
  signOut(): void;
  refreshMe(): Promise<void>;

  startAiGame(level: number, side: 'red' | 'black' | 'random'): Promise<void>;
  tap(square: number): void;
  drop(from: number, to: number): boolean;
  requestUndo(): void;
  respondPrompt(accept: boolean): void;
  resign(): void;
  offerDraw(): void;
  rematch(): void;
  requestHint(): void;
  leaveGame(): void;

  openLobby(): void;
  createRoom(options: {
    name: string; passcode?: string; side: 'red' | 'black' | 'random'; rated: boolean;
    timeControl: TimeControl | null; open: boolean;
  }): void;
  joinRoom(roomId: string, passcode?: string, spectate?: boolean): void;
  leaveRoom(): void;
  sendEmote(emote: Emote): void;
  sendPose(head: number[], hands: number[][]): void;
  sendGrab(square: number): void;
  loadLeaderboard(): Promise<void>;

  startTutorial(fen: string, focus: number | null, obstacles?: number[]): void;
  showToast(text: string, kind?: Toast['kind']): void;
  recentre(): void;
  setSeatOffset(offset: { x: number; z: number }): void;
}

const loadSettings = (): Settings => {
  try {
    const raw = localStorage.getItem('ccx.settings');
    if (raw) return { pieceLabels: 'zh', sound: true, boardScale: 1, immersive: 'vr', ...JSON.parse(raw) };
  } catch { /* fall through to defaults */ }
  return { pieceLabels: 'zh', sound: true, boardScale: 1, immersive: 'vr' };
};

let net: Net;
let controller: GameController;
let engine: Engine | null = null;

export const useStore = create<State>((set, get) => {
  const initialLang = detectLang();
  const settings = loadSettings();
  setSoundEnabled(settings.sound);

  controller = new GameController({
    onSnapshot: (snapshot) => set({ snapshot }),
    onLocalMove: (iccs) => net.send({ t: 'game:move', iccs }),
    onAiGameOver: (result) => {
      net.send({
        t: 'ai:report',
        level: result.level,
        playerColor: result.playerColor,
        moves: result.moves,
        result: result.result,
        undos: result.undos,
      });
    },
    onSound: (sound) => playSound(sound),
  });

  net = new Net({
    onState: (connection) => {
      set({ connection });
      const { s } = get();
      if (connection === 'reconnecting') get().showToast(s.reconnecting, 'warn');
    },
    onMessage: (message) => handle(message, set, get),
  });

  return {
    lang: initialLang,
    s: STRINGS[initialLang],
    screen: 'boot',
    previousScreen: 'menu',

    token: null,
    user: null,
    capabilities: null,
    authBusy: false,
    authError: null,

    connection: 'idle',
    engineReady: false,
    engineInfo: '',

    snapshot: controller.snapshot(),

    rooms: [],
    room: null,
    seat: null,
    clocks: null,
    prompt: null,
    awaitingUndoReply: false,
    rematchRequested: false,
    ratingDelta: null,
    peerEmote: null,
    peerPose: null,
    peerGrab: null,

    leaderboard: [],
    toast: null,
    settings,
    seatOffset: { x: 0, z: 0 },
    recentreNonce: 0,

    // ---------------------------------------------------------------- boot --

    async boot() {
      try {
        set({ capabilities: await api.capabilities() });
      } catch {
        // The API being unreachable must not block offline AI play.
      }

      const token = loadToken();
      if (token) {
        try {
          const me = await api.me(token);
          set({ token, user: me.user, screen: 'menu' });
          net.connect(token);
        } catch {
          saveToken(null);
          set({ screen: 'auth' });
        }
      } else {
        set({ screen: 'auth' });
      }

      // Bring the engine up in the background: the first search should not be
      // the thing that pays for worker startup.
      try {
        engine = createEngine();
        controller.attachEngine(engine);
        await engine.init();
        set({ engineReady: true, engineInfo: engineLabel(engine) });
      } catch (error) {
        console.error('engine failed to start', error);
        set({ engineReady: false, engineInfo: 'unavailable' });
      }
    },

    setLang(lang) {
      localStorage.setItem('ccx.lang', lang);
      set({ lang, s: STRINGS[lang] });
    },

    goto(screen) {
      set((state) => ({ screen, previousScreen: state.screen }));
    },

    updateSettings(patch) {
      const next = { ...get().settings, ...patch };
      localStorage.setItem('ccx.settings', JSON.stringify(next));
      if (patch.sound !== undefined) setSoundEnabled(patch.sound);
      set({ settings: next });
    },

    // ---------------------------------------------------------------- auth --

    async signIn(name, password) {
      return authenticate(() => api.login(name, password), set, get);
    },

    async signUp(name, password) {
      return authenticate(() => api.register(name, password), set, get);
    },

    async playAsGuest(name) {
      return authenticate(() => api.guest(name || 'Guest'), set, get);
    },

    signOut() {
      net.disconnect();
      saveToken(null);
      controller.leave();
      set({ token: null, user: null, screen: 'auth', room: null, seat: null, rooms: [] });
    },

    async refreshMe() {
      const { token } = get();
      if (!token) return;
      try {
        const me = await api.me(token);
        set({ user: me.user });
      } catch { /* keep the cached profile */ }
    },

    // ---------------------------------------------------------------- game --

    async startAiGame(level, side) {
      const colour: Color = side === 'random'
        ? (Math.random() < 0.5 ? RED : BLACK)
        : side === 'red' ? RED : BLACK;
      set({ screen: 'room', room: null, seat: null, clocks: null, prompt: null, ratingDelta: null });
      controller.startAi(level, colour);
    },

    tap(square) {
      controller.tap(square);
    },

    drop(from, to) {
      return controller.drop(from, to);
    },

    requestUndo() {
      const { snapshot, s } = get();
      if (snapshot.mode === 'pvp') {
        if (get().seat === 'spectator' || get().seat === null) return;
        net.send({ t: 'game:undo-request' });
        set({ awaitingUndoReply: true });
        get().showToast(s.undoRequested, 'info');
        return;
      }
      controller.undoLocal();
    },

    respondPrompt(accept) {
      const prompt = get().prompt;
      if (!prompt) return;
      set({ prompt: null });
      if (prompt.kind === 'undo') net.send({ t: 'game:undo-response', accept });
      else net.send({ t: 'game:draw-response', accept });
    },

    resign() {
      if (get().snapshot.mode === 'pvp') net.send({ t: 'game:resign' });
      else controller.resignLocal();
    },

    offerDraw() {
      if (get().snapshot.mode === 'pvp') net.send({ t: 'game:draw-offer' });
    },

    rematch() {
      if (get().snapshot.mode === 'pvp') {
        net.send({ t: 'game:rematch' });
        set({ rematchRequested: true });
        get().showToast(get().s.waitingRematch, 'info');
        return;
      }
      const { snapshot } = get();
      void get().startAiGame(snapshot.aiLevel, snapshot.myColor === RED ? 'red' : 'black');
    },

    requestHint() {
      void controller.requestHint();
    },

    leaveGame() {
      if (get().room) get().leaveRoom();
      controller.leave();
      set({ screen: 'menu', ratingDelta: null, prompt: null });
    },

    // --------------------------------------------------------------- lobby --

    openLobby() {
      set({ screen: 'lobby' });
      net.send({ t: 'lobby:subscribe' });
      net.setResumeIntent([{ t: 'lobby:subscribe' }]);
    },

    createRoom(options) {
      net.send({
        t: 'room:create',
        name: options.name,
        passcode: options.passcode,
        side: options.side,
        rated: options.rated,
        timeControl: options.timeControl,
        open: options.open,
      });
    },

    joinRoom(roomId, passcode, spectate = false) {
      net.send(spectate
        ? { t: 'room:spectate', roomId, passcode }
        : { t: 'room:join', roomId, passcode });
    },

    leaveRoom() {
      net.send({ t: 'room:leave' });
      net.setResumeIntent([]);
      set({ room: null, seat: null, clocks: null, prompt: null, peerPose: null, peerGrab: null });
    },

    sendEmote(emote) {
      net.send({ t: 'room:emote', emote });
    },

    sendPose(head, hands) {
      if (!get().room) return;
      net.send({
        t: 'room:pose',
        head: head as [number, number, number, number, number, number, number],
        hands: hands as Array<[number, number, number, number, number, number, number]>,
      });
    },

    sendGrab(square) {
      if (get().room) net.send({ t: 'game:grab', square });
    },

    async loadLeaderboard() {
      try {
        const { entries } = await api.leaderboard(25);
        set({ leaderboard: entries });
      } catch { /* leave the previous list up */ }
    },

    // ------------------------------------------------------------ tutorial --

    startTutorial(fen, focus, obstacles = []) {
      controller.startTutorial(fen, focus, obstacles);
    },

    recentre() {
      set((state) => ({ recentreNonce: state.recentreNonce + 1 }));
    },

    setSeatOffset(seatOffset) {
      set({ seatOffset });
    },

    showToast(text, kind = 'info') {
      set({ toast: { text, kind, at: Date.now() } });
      window.setTimeout(() => {
        if (get().toast?.text === text) set({ toast: null });
      }, 4000);
    },
  };
});

// --------------------------------------------------------------------- helpers

type Setter = (partial: Partial<State> | ((state: State) => Partial<State>)) => void;
type Getter = () => State;

const authenticate = async (
  call: () => Promise<{ token: string; user: ApiUser }>, set: Setter, get: Getter,
): Promise<boolean> => {
  set({ authBusy: true, authError: null });
  try {
    const { token, user } = await call();
    saveToken(token);
    set({ token, user, authBusy: false, screen: 'menu' });
    net.connect(token);
    return true;
  } catch (error) {
    set({ authBusy: false, authError: apiErrorText(error, get().lang) });
    return false;
  }
};

const seatColor = (seat: State['seat']): Color | null =>
  seat === 'red' ? RED : seat === 'black' ? BLACK : null;

const handle = (message: ServerMessage, set: Setter, get: Getter): void => {
  const { s } = get();
  switch (message.t) {
    case 'hello':
      set({ user: { ...(get().user as ApiUser), ...toApiUser(message.user, get().user) } });
      break;

    case 'error':
      get().showToast(message.message, 'warn');
      if (message.code === 'BAD_PASSCODE') get().showToast(s.wrongPasscode, 'warn');
      break;

    case 'lobby:rooms':
      set({ rooms: message.rooms });
      break;

    case 'leaderboard':
      set({ leaderboard: message.entries as unknown as ApiUser[] });
      break;

    case 'room:joined': {
      const seat = message.you;
      set({
        room: message.room,
        seat,
        screen: 'room',
        prompt: null,
        ratingDelta: null,
        rematchRequested: false,
        awaitingUndoReply: false,
      });
      // Re-join the same room automatically if the socket drops.
      net.setResumeIntent([{ t: 'room:join', roomId: message.room.id }]);
      controller.startPvp(seatColor(seat));
      break;
    }

    case 'room:state':
      set({ room: message.room });
      break;

    case 'room:left':
      set({ room: null, seat: null, clocks: null, peerPose: null, peerGrab: null });
      net.setResumeIntent([]);
      break;

    case 'room:emote':
      if (message.from !== get().user?.id) set({ peerEmote: { emote: message.emote, at: Date.now() } });
      break;

    case 'room:pose':
      set({ peerPose: { head: message.head, hands: message.hands } });
      break;

    case 'game:grab':
      set({ peerGrab: message.square < 0 ? null : message.square });
      break;

    case 'game:state':
      controller.applyServerState(message.state, seatColor(get().seat));
      set({ clocks: message.state.clocks, awaitingUndoReply: false });
      break;

    case 'game:undo-requested':
      set({ prompt: { kind: 'undo', byName: message.byName } });
      playSound('ui');
      break;

    case 'game:undo-result':
      set({ awaitingUndoReply: false });
      get().showToast(message.accepted ? s.undoAccepted : s.undoDeclined, message.accepted ? 'good' : 'warn');
      break;

    case 'game:draw-offered':
      set({ prompt: { kind: 'draw', byName: message.byName } });
      playSound('ui');
      break;

    case 'game:draw-result':
      if (!message.accepted) get().showToast(s.undoDeclined, 'warn');
      break;

    case 'game:over': {
      const mine = message.ratings.find((r) => r.userId === get().user?.id);
      set({ ratingDelta: mine ? { before: mine.before, after: mine.after } : null });
      void get().refreshMe();
      break;
    }

    case 'ai:rated':
      if (message.rating) {
        set({ ratingDelta: { before: message.rating.before, after: message.rating.after } });
        void get().refreshMe();
      }
      break;

    case 'pong':
      break;
  }
};

const toApiUser = (user: PublicUser, previous: ApiUser | null): Partial<ApiUser> => ({
  id: user.id,
  name: user.name,
  rating: user.rating,
  rd: user.rd,
  provisional: user.provisional,
  guest: user.guest,
  wins: previous?.wins ?? 0,
  losses: previous?.losses ?? 0,
  draws: previous?.draws ?? 0,
  aiWins: previous?.aiWins ?? 0,
  aiLosses: previous?.aiLosses ?? 0,
  aiDraws: previous?.aiDraws ?? 0,
});

export const getController = (): GameController => controller;
