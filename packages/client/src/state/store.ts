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
import {
  ApiError, api, apiErrorText, takeLegacyToken,
  type ApiUser, type ServerCapabilities, type SessionInfo, type SessionResponse,
} from './api.js';
import { requestPersistentStorage, storageIsPersisted } from './storage.js';
import { createEngine, engineLabel } from './engine.js';
import { GameController, type Snapshot } from './gameController.js';
import { Net, type ConnectionState } from './net.js';
import { playSound, setSoundEnabled } from './sound.js';

export type Screen =
  | 'boot' | 'auth' | 'menu' | 'ai-setup' | 'lobby' | 'room' | 'tutorial'
  | 'leaderboard' | 'settings'
  /** Headset side of pairing: showing a code and waiting for a phone. */
  | 'link'
  /** Phone side of pairing, at /link: typing that code in and approving it. */
  | 'approve';

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
  /**
   * Stay signed in on this device across browser restarts.
   *
   * On by default, because the alternative on a headset is retyping a password
   * with a laser pointer. Off gives a session that dies with the browser, which
   * is the right answer for a headset the whole house wears.
   */
  persistSession: boolean;
}

/** A pairing in flight, as the headset sees it. */
export interface LinkFlow {
  /** Shown to the player, formatted `BKQP-7RTM`. */
  userCode: string;
  /** Where to go on the phone. */
  url: string;
  status: 'pending' | 'ready' | 'denied' | 'expired';
  expiresAt: number;
  error: string | null;
}

interface State {
  lang: Lang;
  s: Strings;
  screen: Screen;
  previousScreen: Screen;

  user: ApiUser | null;
  session: SessionInfo | null;
  capabilities: ServerCapabilities | null;
  authBusy: boolean;
  authError: string | null;
  /** Whether the browser promised not to evict this origin's data. */
  storagePersisted: boolean;
  link: LinkFlow | null;

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
  playAsGuest(name?: string): Promise<boolean>;
  /** Keep this guest's rating and give it a password. */
  claimAccount(name: string, password: string): Promise<boolean>;
  signOut(): Promise<void>;
  refreshMe(): Promise<void>;
  setPersistSession(persist: boolean): Promise<void>;
  startLink(): Promise<void>;
  cancelLink(): void;

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

const DEFAULT_SETTINGS: Settings = {
  pieceLabels: 'zh', sound: true, boardScale: 1, immersive: 'vr', persistSession: true,
};

const loadSettings = (): Settings => {
  try {
    const raw = localStorage.getItem('ccx.settings');
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_SETTINGS };
};

let net: Net;
let controller: GameController;
let engine: Engine | null = null;

/**
 * The secret half of a pairing, and its timer. Deliberately module-level rather
 * than in the store: the device code is a credential, and nothing that can end
 * up in a state snapshot, a devtools inspector, or a React tree should hold one.
 */
let pairing: { userCode: string; deviceCode: string; intervalMs: number } | null = null;
let pollTimer: number | null = null;
/** Guards the one-session-at-a-time bootstrap against re-entering itself. */
let resuming = false;

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
    // Handshakes that never open may just be Wi-Fi, but they are also what a
    // dead session looks like — so check whether we are still signed in.
    onStalled: () => { void get().refreshMe(); },
  });

  return {
    lang: initialLang,
    s: STRINGS[initialLang],
    screen: 'boot',
    previousScreen: 'menu',

    user: null,
    session: null,
    capabilities: null,
    authBusy: false,
    authError: null,
    storagePersisted: false,
    link: null,

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

      // /link is the phone half of pairing. It gets a keyboard and a text
      // field, and nothing else: no identity of its own, no engine, no board.
      if (isApprovePage()) {
        set({ screen: 'approve' });
        return;
      }

      await openSession(set, get);

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
      return authenticate(() => api.login(name, password, get().settings.persistSession), set, get);
    },

    async signUp(name, password) {
      return authenticate(() => api.register(name, password, get().settings.persistSession), set, get);
    },

    async playAsGuest(name) {
      const { lang, settings } = get();
      return authenticate(() => api.guest(lang, settings.persistSession, name || undefined), set, get);
    },

    async claimAccount(name, password) {
      const claimed = await authenticate(() => api.claim(name, password), set, get);
      if (claimed) get().showToast(get().s.accountClaimed, 'good');
      return claimed;
    },

    async signOut() {
      get().cancelLink();
      net.disconnect();
      controller.leave();
      try {
        await api.logout();
      } catch { /* the cookie is gone locally either way once we clear state */ }
      set({
        user: null, session: null, screen: 'auth', room: null, seat: null, rooms: [],
        authError: null,
      });
    },

    async refreshMe() {
      try {
        const me = await api.me();
        set({ user: me.user, session: me.session });
      } catch (error) {
        // A 401 here means the session really is gone — expired, evicted, or
        // signed out elsewhere. Anything else is the network, so keep the
        // cached profile and let the socket keep retrying.
        if (!(error instanceof ApiError) || error.status !== 401) return;
        net.disconnect();
        set({ user: null, session: null });
        // Not mid-game: replacing the player's identity while they are sitting
        // at a board would silently turn them into a different person, and the
        // local AI game in front of them is still perfectly playable.
        if (get().screen === 'room' || get().screen === 'tutorial') {
          get().showToast(apiErrorText(error, get().lang), 'warn');
          return;
        }
        await openSession(set, get);
      }
    },

    async setPersistSession(persist) {
      get().updateSettings({ persistSession: persist });
      try {
        const result = await api.setPersist(persist);
        set({ session: result.session });
      } catch { /* the preference is stored; the cookie re-stamps on next visit */ }
      // There is no way to *un*-persist storage once granted, and no need: the
      // cookie is what carries the session, and it is now a session cookie.
      if (persist) set({ storagePersisted: await requestPersistentStorage() });
    },

    // -------------------------------------------------------------- pairing --

    async startLink() {
      get().cancelLink();
      set({ authBusy: true, authError: null });
      try {
        const started = await api.link.start();
        pairing = {
          userCode: started.userCode,
          deviceCode: started.deviceCode,
          intervalMs: Math.max(1000, started.interval * 1000),
        };
        set({
          authBusy: false,
          screen: 'link',
          link: {
            userCode: started.userCode,
            url: started.url,
            status: 'pending',
            expiresAt: Date.now() + started.expiresIn * 1000,
            error: null,
          },
        });
        schedulePoll(set, get);
      } catch (error) {
        set({ authBusy: false, authError: apiErrorText(error, get().lang) });
      }
    },

    cancelLink() {
      if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
      const code = pairing?.userCode;
      pairing = null;
      // Tell the server so the code dies now rather than in ten minutes; if the
      // call fails it expires on its own, so there is nothing to report.
      if (code) void api.link.deny(code).catch(() => {});
      set({ link: null });
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
      // If the session died while they were playing, this is the moment to get
      // them an identity again — they are no longer mid-board.
      if (!get().user) void openSession(set, get);
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

/** Is this the phone half of pairing rather than the game? */
const isApprovePage = (): boolean =>
  typeof location !== 'undefined' && location.pathname.replace(/\/+$/, '') === '/link';

const authenticate = async (
  call: () => Promise<SessionResponse>, set: Setter, get: Getter,
): Promise<boolean> => {
  set({ authBusy: true, authError: null });
  try {
    const result = await call();
    applySession(result, set, get);
    set({ authBusy: false });
    return true;
  } catch (error) {
    set({ authBusy: false, authError: apiErrorText(error, get().lang) });
    return false;
  }
};

/** Adopt a session the server just handed us, and get on the wire with it. */
const applySession = (result: SessionResponse, set: Setter, get: Getter): void => {
  set({ user: result.user, session: result.session, screen: 'menu', authError: null });
  net.connect();
  if (get().settings.persistSession) {
    void requestPersistentStorage().then((storagePersisted) => set({ storagePersisted }));
  } else {
    void storageIsPersisted().then((storagePersisted) => set({ storagePersisted }));
  }
};

/**
 * Get the player into the game with an identity, without asking them for one.
 *
 * Resume the cookie if there is one; otherwise mint a named guest and go
 * straight to the board. Nobody types anything on a headset to start playing,
 * and because a guest is a real account row the rating it earns survives being
 * claimed later. If even that fails — no network, or guests turned off — the
 * offline AI is still playable, so land on the menu rather than a dead form.
 */
const openSession = async (set: Setter, get: Getter): Promise<void> => {
  if (resuming) return;
  resuming = true;
  try {
    const legacy = takeLegacyToken();
    if (legacy) {
      try {
        applySession(await api.adopt(legacy, get().settings.persistSession), set, get);
        return;
      } catch { /* expired or rejected; fall through to the cookie */ }
    }

    try {
      const me = await api.me();
      applySession(me, set, get);
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        // The server is unreachable. Offline AI play still works.
        set({ screen: 'menu' });
        get().showToast(get().s.offlineNotice, 'warn');
        return;
      }
    }

    if (get().capabilities?.allowGuests === false) {
      set({ screen: 'auth' });
      return;
    }

    try {
      const guest = await api.guest(get().lang, get().settings.persistSession);
      applySession(guest, set, get);
      get().showToast(get().s.guestWelcome.replace('{name}', guest.user.name), 'good');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'guests-disabled') {
        const capabilities = get().capabilities;
        set({ screen: 'auth', ...(capabilities ? { capabilities: { ...capabilities, allowGuests: false } } : {}) });
        return;
      }
      set({ screen: 'menu' });
      get().showToast(get().s.offlineNotice, 'warn');
    }
  } finally {
    resuming = false;
  }
};

/**
 * Ask the server whether the phone is done yet.
 *
 * Polling rather than a socket because this runs before there is a session to
 * open a socket with, and because it has to keep working from inside an
 * immersive session, where the only thing available is fetch.
 */
const schedulePoll = (set: Setter, get: Getter): void => {
  if (pollTimer !== null) clearTimeout(pollTimer);
  if (!pairing) return;
  pollTimer = window.setTimeout(() => void poll(set, get), pairing.intervalMs);
};

const poll = async (set: Setter, get: Getter): Promise<void> => {
  const active = pairing;
  const flow = get().link;
  if (!active || !flow) return;

  if (flow.expiresAt <= Date.now()) {
    pairing = null;
    set({ link: { ...flow, status: 'expired' } });
    return;
  }

  try {
    const result = await api.link.poll(
      active.userCode, active.deviceCode, get().settings.persistSession,
    );
    if (result.status === 'ready') {
      pairing = null;
      set({ link: null });
      applySession(result, set, get);
      get().showToast(get().s.linkedAs.replace('{name}', result.user.name), 'good');
      return;
    }
    if (result.status === 'pending') {
      set({ link: { ...flow, expiresAt: Date.now() + result.expiresIn * 1000 } });
      schedulePoll(set, get);
      return;
    }
    pairing = null;
    set({ link: { ...flow, status: result.status } });
  } catch (error) {
    // `slow-down` is the server pacing us, not a failure; anything else that is
    // transient deserves the same treatment — keep waiting until the code dies.
    if (error instanceof ApiError && error.code === 'bad-device-code') {
      pairing = null;
      set({ link: { ...flow, status: 'expired' } });
      return;
    }
    schedulePoll(set, get);
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
