/**
 * The flat interface — the browser-window half of the app.
 *
 * It is a peer of the in-headset interface, not a menu you pass through: the
 * whole game (AI, rooms, tutorial, ratings) is playable on a screen. That keeps
 * the project testable without a headset, gives desktop players a real
 * experience, and means a Quest player can browse rooms in the 2D browser and
 * then drop into VR already seated at a table.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { LEVELS } from '@ccx/ai';
import { LESSONS, RED, type RoomSummary } from '@ccx/shared';
import { reasonText } from '../i18n/index.js';
import { api, apiErrorText, type LinkLookup } from '../state/api.js';
import { useStore } from '../state/store.js';
import type { Store } from '../xr/XRApp.js';

// ------------------------------------------------------------------- helpers --

export const useXRMode = (store: Store): XRSessionMode | null =>
  useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState().mode,
    () => null,
  );

/** mm:ss remaining, re-rendered once a second while it matters. */
export const useCountdown = (until: number | null): string => {
  const [, tick] = useState(0);
  useEffect(() => {
    if (until === null) return;
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  if (until === null) return '';
  const seconds = Math.max(0, Math.round((until - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/** Pairing codes are read aloud off a panel, so display them grouped. */
const withDash = (code: string): string =>
  (code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

const cleanCode = (input: string): string =>
  input.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

const useSessionSupport = () => {
  const [support, setSupport] = useState<{ vr: boolean; ar: boolean; checked: boolean }>({
    vr: false, ar: false, checked: false,
  });
  useEffect(() => {
    const xr = navigator.xr;
    if (!xr) { setSupport({ vr: false, ar: false, checked: true }); return; }
    void Promise.all([
      xr.isSessionSupported('immersive-vr').catch(() => false),
      xr.isSessionSupported('immersive-ar').catch(() => false),
    ]).then(([vr, ar]) => setSupport({ vr, ar, checked: true }));
  }, []);
  return support;
};

// -------------------------------------------------------------------- top bar --

export const TopBar = ({ store }: { store: Store }) => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const user = useStore((state) => state.user);
  const connection = useStore((state) => state.connection);
  const screen = useStore((state) => state.screen);
  const { setLang, goto, signOut } = useStore.getState();
  const support = useSessionSupport();

  return (
    <header className="topbar">
      <div className="brand">
        <span>中国象棋</span>
        <small>{lang === 'zh' ? 'WebXR' : 'Xiangqi · WebXR'}</small>
      </div>
      <div className="spacer" />

      {connection === 'reconnecting' ? <span className="muted">{s.reconnecting}</span> : null}

      {support.vr ? (
        <button className="primary" onClick={() => void store.enterVR()}>{s.enterVr}</button>
      ) : support.checked ? (
        <span className="muted hint-bar">{s.vrUnsupported}</span>
      ) : (
        <span className="muted hint-bar">{s.vrChecking}</span>
      )}
      {support.ar ? (
        <button onClick={() => void store.enterAR()}>{s.enterAr}</button>
      ) : null}

      <button
        className="ghost"
        onClick={() => setLang(lang === 'zh' ? 'en' : 'zh')}
        aria-label={s.language}
      >
        {lang === 'zh' ? 'EN' : '中文'}
      </button>

      {user ? (
        <button
          className="ghost"
          onClick={() => (screen === 'settings' ? goto('menu') : goto('settings'))}
          title={s.settings}
        >
          {user.name}
          {user.guest ? ` · ${s.guestBadge}` : ` · ${user.rating}${user.provisional ? '?' : ''}`}
        </button>
      ) : null}
      {user && !user.guest ? (
        <button className="ghost" onClick={() => void signOut()}>{s.signOut}</button>
      ) : null}
    </header>
  );
};

// ---------------------------------------------------------------------- auth --

export const AuthScreen = () => {
  const s = useStore((state) => state.s);
  const busy = useStore((state) => state.authBusy);
  const error = useStore((state) => state.authError);
  const capabilities = useStore((state) => state.capabilities);
  const { signIn, signUp, playAsGuest, startLink } = useStore.getState();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void (mode === 'in' ? signIn(name, password) : signUp(name, password));
  };

  return (
    <div className="center-pane">
      <div className="card sheet stack">
        <h2 style={{ margin: 0 }}>{mode === 'in' ? s.signIn : s.signUp}</h2>

        {/* First, because on a headset typing a password is the worst thing we
            could ask for and this path needs no keyboard at all. */}
        <button className="menu-item big" onClick={() => void startLink()} disabled={busy}>
          <strong>{s.linkWithPhone}</strong>
          <span>{s.linkWithPhoneSub}</span>
        </button>

        <form className="stack" onSubmit={submit}>
          <label className="field">
            {s.displayName}
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" maxLength={20} />
          </label>
          <label className="field">
            {s.password}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            />
            {mode === 'up' ? <span className="muted">{s.passwordHint}</span> : null}
          </label>
          {error ? <div className="error">{error}</div> : null}
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !name || !password}>
              {mode === 'in' ? s.signIn : s.signUp}
            </button>
            <button type="button" className="ghost" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>
              {mode === 'in' ? s.signUp : s.signIn}
            </button>
            <div className="spacer" />
            {capabilities?.allowGuests !== false ? (
              <button type="button" disabled={busy} onClick={() => void playAsGuest(name)}>
                {s.playAsGuest}
              </button>
            ) : null}
          </div>
        </form>

        <PersistToggle />
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{s.guestNotice}</p>
      </div>
    </div>
  );
};

/** The "stay signed in on this device" switch, shared by auth and settings. */
const PersistToggle = () => {
  const s = useStore((state) => state.s);
  const settings = useStore((state) => state.settings);
  const persisted = useStore((state) => state.storagePersisted);
  const { setPersistSession } = useStore.getState();

  return (
    <div className="stack" style={{ gap: 4 }}>
      <label className="row" style={{ gap: 8 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={settings.persistSession}
          onChange={(e) => void setPersistSession(e.target.checked)}
        />
        {s.staySignedIn}
      </label>
      <span className="muted" style={{ fontSize: 13 }}>{s.staySignedInHint}</span>
      {settings.persistSession ? (
        <span className="muted" style={{ fontSize: 13 }}>
          {persisted ? s.storageKept : s.storageEvictable}
        </span>
      ) : null}
    </div>
  );
};

/**
 * The headset half of pairing: a code to read out and nothing to type.
 *
 * Shown in the flat interface; {@link LinkPanel} is the same flow inside a
 * session, because this is exactly the moment you must not ask someone to take
 * the headset off.
 */
export const LinkScreen = () => {
  const s = useStore((state) => state.s);
  const link = useStore((state) => state.link);
  const user = useStore((state) => state.user);
  const error = useStore((state) => state.authError);
  const busy = useStore((state) => state.authBusy);
  const { startLink, cancelLink, goto } = useStore.getState();
  const remaining = useCountdown(link?.status === 'pending' ? link.expiresAt : null);

  // A guest who came here to upgrade is already signed in; only somebody with
  // no identity at all belongs back on the sign-in screen.
  const done = () => { cancelLink(); goto(user ? 'menu' : 'auth'); };

  return (
    <div className="center-pane">
      <div className="card sheet stack" style={{ textAlign: 'center' }}>
        <h2 style={{ margin: 0 }}>{s.linkTitle}</h2>

        {link ? (
          <>
            <div className="stack" style={{ gap: 4 }}>
              <span className="muted">{s.linkStep1}</span>
              <strong style={{ fontSize: 20, wordBreak: 'break-all' }}>{link.url}</strong>
            </div>
            <div className="stack" style={{ gap: 4 }}>
              <span className="muted">{s.linkStep2}</span>
              <strong style={{ fontSize: 44, letterSpacing: '0.12em', fontVariantNumeric: 'tabular-nums' }}>
                {link.userCode}
              </strong>
            </div>

            {link.status === 'pending' ? (
              <span className="muted">
                {s.linkWaiting} · {s.linkExpiresIn.replace('{time}', remaining)}
              </span>
            ) : null}
            {link.status === 'expired' ? <div className="error">{s.linkExpired}</div> : null}
            {link.status === 'denied' ? <div className="error">{s.linkDenied}</div> : null}
          </>
        ) : (
          <span className="muted">{error ?? '…'}</span>
        )}

        <div className="row" style={{ justifyContent: 'center' }}>
          {!link || link.status !== 'pending' ? (
            <button className="primary" disabled={busy} onClick={() => void startLink()}>{s.linkRetry}</button>
          ) : null}
          <button className="ghost" onClick={done}>{s.cancel}</button>
        </div>
        <p className="hint-bar" style={{ margin: 0 }}>{s.linkPassthroughHint}</p>
      </div>
    </div>
  );
};

/**
 * The phone half of pairing, served at /link.
 *
 * This page never creates an identity of its own and never joins a game — it
 * exists so that the one part of the experience that genuinely needs a keyboard
 * happens on a device that has one.
 */
export const ApproveScreen = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const [code, setCode] = useState(() => {
    try {
      return cleanCode(new URLSearchParams(location.search).get('c') ?? '');
    } catch {
      return '';
    }
  });
  const [stage, setStage] = useState<'code' | 'choose' | 'attach' | 'claim' | 'done' | 'denied'>('code');
  const [waiting, setWaiting] = useState<LinkLookup['waiting']>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(apiErrorText(failure, lang));
    } finally {
      setBusy(false);
    }
  };

  const lookup = () => run(async () => {
    const found = await api.link.lookup(code);
    setWaiting(found.waiting);
    if (found.waiting?.claimable) {
      setName(found.waiting.name);
      setStage('choose');
    } else {
      setStage('attach');
    }
  });

  const approve = (mode: 'attach' | 'claim') => run(async () => {
    await api.link.approve(code, mode, name, password);
    setStage('done');
  });

  const deny = () => run(async () => {
    await api.link.deny(code);
    setStage('denied');
  });

  if (stage === 'done' || stage === 'denied') {
    return (
      <div className="center-pane">
        <div className="card sheet stack" style={{ textAlign: 'center' }}>
          <h2 style={{ margin: 0 }}>{stage === 'done' ? s.approveDone : s.approveDenied}</h2>
          {stage === 'done' ? <span className="muted">{s.approveDoneHint}</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="center-pane">
      <div className="card sheet stack">
        <h2 style={{ margin: 0 }}>{s.approveTitle}</h2>

        {stage === 'code' ? (
          <form
            className="stack"
            onSubmit={(event) => { event.preventDefault(); lookup(); }}
          >
            <span className="muted">{s.approveIntro}</span>
            <label className="field">
              {s.pairingCode}
              <input
                value={withDash(code)}
                onChange={(e) => setCode(cleanCode(e.target.value))}
                autoComplete="one-time-code"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                style={{ fontSize: 28, letterSpacing: '0.12em', textAlign: 'center' }}
                autoFocus
              />
            </label>
            {error ? <div className="error">{error}</div> : null}
            <button className="primary big" type="submit" disabled={busy || code.length !== 8}>
              {s.approveContinue}
            </button>
          </form>
        ) : null}

        {stage === 'choose' && waiting ? (
          <div className="stack">
            <span>{s.approveFoundGuest.replace('{name}', waiting.name)}</span>
            <button className="menu-item big" onClick={() => setStage('claim')}>
              <strong>{s.approveKeepGuest}</strong>
              <span>{s.claimHint}</span>
            </button>
            <button className="menu-item" onClick={() => { setName(''); setStage('attach'); }}>
              <strong>{s.approveUseAccount}</strong>
            </button>
            <button className="ghost" disabled={busy} onClick={deny}>{s.approveDeny}</button>
          </div>
        ) : null}

        {stage === 'attach' || stage === 'claim' ? (
          <form
            className="stack"
            onSubmit={(event) => { event.preventDefault(); approve(stage); }}
          >
            <span className="muted">
              {stage === 'claim' ? s.claimHint : s.approveUseAccount}
            </span>
            <label className="field">
              {s.displayName}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="username"
                maxLength={20}
                autoFocus
              />
            </label>
            <label className="field">
              {s.password}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={stage === 'claim' ? 'new-password' : 'current-password'}
              />
              {stage === 'claim' ? <span className="muted">{s.passwordHint}</span> : null}
            </label>
            {error ? <div className="error">{error}</div> : null}
            <div className="row">
              <button className="primary" type="submit" disabled={busy || !name || !password}>
                {stage === 'claim' ? s.claimAccount : s.signIn}
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={deny}>{s.approveDeny}</button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------- menu --

export const MenuScreen = () => {
  const s = useStore((state) => state.s);
  const user = useStore((state) => state.user);
  const { goto, openLobby, loadLeaderboard } = useStore.getState();
  return (
    <div className="center-pane">
      <div className="card sheet menu-grid">
        <button className="menu-item big" onClick={() => goto('ai-setup')}>
          <strong>{s.playAi}</strong>
          <span>{s.playAiSub}</span>
        </button>
        <button className="menu-item big" onClick={openLobby}>
          <strong>{s.playHuman}</strong>
          <span>{s.playHumanSub}</span>
        </button>
        <button className="menu-item big" onClick={() => goto('tutorial')}>
          <strong>{s.tutorial}</strong>
          <span>{s.tutorialSub}</span>
        </button>
        <button
          className="menu-item"
          onClick={() => { void loadLeaderboard(); goto('leaderboard'); }}
        >
          <strong>{s.leaderboard}</strong>
        </button>
        {/* A guest is a real account that simply has no password yet, so the
            offer is to keep it rather than to sign up from scratch. */}
        {user?.guest ? (
          <button className="menu-item" onClick={() => goto('settings')}>
            <strong>{s.claimAccount}</strong>
            <span>{s.claimAccountSub.replace('{name}', user.name)}</span>
          </button>
        ) : null}
        <p className="hint-bar" style={{ margin: 0 }}>{s.flatModeHint}</p>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ AI setup --

export const AiSetupScreen = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const engineReady = useStore((state) => state.engineReady);
  const engineInfo = useStore((state) => state.engineInfo);
  const { goto, startAiGame } = useStore.getState();
  const [level, setLevel] = useState(() => Number(localStorage.getItem('ccx.level') ?? 4));
  const [side, setSide] = useState<'red' | 'black' | 'random'>('red');
  const spec = LEVELS[Math.min(8, Math.max(1, level)) - 1]!;

  return (
    <div className="center-pane">
      <div className="card sheet stack">
        <h2 style={{ margin: 0 }}>{s.playAi}</h2>

        <label className="field">
          {s.difficulty}: <strong>{level} · {spec.label[lang]}</strong>
          <input
            type="range"
            min={1}
            max={8}
            step={1}
            value={level}
            onChange={(e) => {
              const next = Number(e.target.value);
              setLevel(next);
              localStorage.setItem('ccx.level', String(next));
            }}
          />
          <span className="muted">
            {s.aiStrength} {spec.rating} · {spec.depth} ply · {(spec.timeMs / 1000).toFixed(1)}s
            {spec.blunderChance > 0 ? ` · ${Math.round(spec.blunderChance * 100)}% slips` : ''}
          </span>
        </label>

        <div className="field">
          {s.yourSide}
          <div className="row">
            {(['red', 'black', 'random'] as const).map((option) => (
              <button
                key={option}
                aria-pressed={side === option}
                className={side === option ? 'primary' : ''}
                onClick={() => setSide(option)}
              >
                {option === 'red' ? s.red : option === 'black' ? s.black : s.randomSide}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <button
            className="primary big"
            disabled={!engineReady}
            onClick={() => void startAiGame(level, side)}
          >
            {s.startGame}
          </button>
          <button className="ghost" onClick={() => goto('menu')}>{s.back}</button>
          <div className="spacer" />
          <span className="muted hint-bar">{engineInfo}</span>
        </div>
      </div>
    </div>
  );
};

// --------------------------------------------------------------------- lobby --

export const LobbyScreen = () => {
  const s = useStore((state) => state.s);
  const rooms = useStore((state) => state.rooms);
  const user = useStore((state) => state.user);
  const { goto, joinRoom, createRoom } = useStore.getState();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<RoomSummary | null>(null);
  const [passcode, setPasscode] = useState('');

  return (
    <div className="center-pane">
      <div className="card sheet stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>{s.rooms}</h2>
          <div className="spacer" />
          <button className="primary" onClick={() => setCreating((value) => !value)}>{s.createRoom}</button>
          <button className="ghost" onClick={() => goto('menu')}>{s.back}</button>
        </div>

        {creating ? (
          <CreateRoomForm
            defaultName={`${user?.name ?? 'Player'}`}
            onCreate={(options) => { createRoom(options); setCreating(false); }}
            onCancel={() => setCreating(false)}
          />
        ) : null}

        {pending ? (
          <div className="card stack">
            <label className="field">
              {s.enterPasscode} — {pending.name}
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
            </label>
            <div className="row">
              <button
                className="primary"
                disabled={passcode.length < 4}
                onClick={() => { joinRoom(pending.id, passcode); setPending(null); setPasscode(''); }}
              >
                {s.join}
              </button>
              <button className="ghost" onClick={() => { setPending(null); setPasscode(''); }}>{s.back}</button>
            </div>
          </div>
        ) : null}

        <div className="list">
          {rooms.length === 0 ? <p className="muted">{s.noRooms}</p> : null}
          {rooms.map((room) => (
            <div className="room" key={room.id}>
              <div>
                <div>
                  <strong>{room.name}</strong> <span className="muted">#{room.id}</span>
                </div>
                <div className="meta">
                  <span className={`tag ${room.status === 'waiting' ? 'live' : ''}`}>
                    {room.status === 'waiting' ? s.waiting : room.status === 'playing' ? s.playing : s.finished}
                  </span>
                  {room.hasPasscode ? <span className="tag locked">{s.locked}</span> : null}
                  {room.rated ? <span className="tag">★</span> : null}
                  {room.timeControl
                    ? <span className="tag">{room.timeControl.initialSeconds / 60}′+{room.timeControl.incrementSeconds}″</span>
                    : <span className="tag">{s.untimed}</span>}
                  {room.host.name} · {room.host.rating}
                  {room.spectators > 0 ? ` · ${room.spectators} ${s.spectators}` : ''}
                </div>
              </div>
              <button
                className={room.status === 'waiting' ? 'primary' : ''}
                onClick={() => {
                  if (room.hasPasscode) { setPending(room); return; }
                  joinRoom(room.id, undefined, room.status !== 'waiting');
                }}
              >
                {room.status === 'waiting' ? s.join : s.spectate}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const CreateRoomForm = ({
  defaultName, onCreate, onCancel,
}: {
  defaultName: string;
  onCreate: (options: {
    name: string; passcode?: string; side: 'red' | 'black' | 'random'; rated: boolean;
    timeControl: { initialSeconds: number; incrementSeconds: number } | null; open: boolean;
  }) => void;
  onCancel: () => void;
}) => {
  const s = useStore((state) => state.s);
  const [name, setName] = useState(`${defaultName}`);
  const [passcode, setPasscode] = useState('');
  const [side, setSide] = useState<'red' | 'black' | 'random'>('random');
  const [rated, setRated] = useState(true);
  const [open, setOpen] = useState(true);
  const [minutes, setMinutes] = useState(0);

  return (
    <div className="card stack">
      <label className="field">
        {s.roomName}
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <label className="field">
        {s.passcodeOptional}
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={8}
          placeholder="4–8"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      <div className="row wrap">
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={rated} onChange={(e) => setRated(e.target.checked)} />
          {s.ratedGame}
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={open} onChange={(e) => setOpen(e.target.checked)} />
          {s.allowSpectators}
        </label>
        <label className="row" style={{ gap: 6 }}>
          {s.timeControl}
          <select
            style={{ width: 'auto' }}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            <option value={0}>{s.untimed}</option>
            {[3, 5, 10, 15, 30].map((m) => <option key={m} value={m}>{m}′ + 3″</option>)}
          </select>
        </label>
      </div>
      <div className="row">
        {(['red', 'black', 'random'] as const).map((option) => (
          <button
            key={option}
            aria-pressed={side === option}
            className={side === option ? 'primary' : ''}
            onClick={() => setSide(option)}
          >
            {option === 'red' ? s.red : option === 'black' ? s.black : s.randomSide}
          </button>
        ))}
        <div className="spacer" />
        <button
          className="primary"
          disabled={!name.trim() || (passcode.length > 0 && passcode.length < 4)}
          onClick={() => onCreate({
            name: name.trim(),
            passcode: passcode.length >= 4 ? passcode : undefined,
            side,
            rated,
            open,
            timeControl: minutes > 0 ? { initialSeconds: minutes * 60, incrementSeconds: 3 } : null,
          })}
        >
          {s.createRoom}
        </button>
        <button className="ghost" onClick={onCancel}>{s.back}</button>
      </div>
    </div>
  );
};

// --------------------------------------------------------------- leaderboard --

export const LeaderboardScreen = () => {
  const s = useStore((state) => state.s);
  const entries = useStore((state) => state.leaderboard);
  const goto = useStore((state) => state.goto);

  return (
    <div className="center-pane">
      <div className="card sheet stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>{s.leaderboard}</h2>
          <div className="spacer" />
          <button className="ghost" onClick={() => goto('menu')}>{s.back}</button>
        </div>
        <table className="ladder">
          <thead>
            <tr>
              <th>#</th>
              <th>{s.displayName}</th>
              <th className="num">★</th>
              <th className="num">W/L/D</th>
              <th className="num">AI</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, index) => (
              <tr key={entry.id}>
                <td className="muted">{index + 1}</td>
                <td>{entry.name}{entry.provisional ? ' ?' : ''}</td>
                <td className="num"><strong>{entry.rating}</strong></td>
                <td className="num muted">{entry.wins}/{entry.losses}/{entry.draws}</td>
                <td className="num muted">{entry.aiWins}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length === 0 ? <p className="muted">—</p> : null}
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ settings --

export const SettingsScreen = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const settings = useStore((state) => state.settings);
  const engineInfo = useStore((state) => state.engineInfo);
  const capabilities = useStore((state) => state.capabilities);
  const { goto, setLang, updateSettings } = useStore.getState();

  return (
    <div className="center-pane">
      <div className="card sheet stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>{s.settings}</h2>
          <div className="spacer" />
          <button className="ghost" onClick={() => goto('menu')}>{s.back}</button>
        </div>

        <AccountSection />

        <div className="field">
          {s.language}
          <div className="row">
            <button className={lang === 'zh' ? 'primary' : ''} onClick={() => setLang('zh')}>中文</button>
            <button className={lang === 'en' ? 'primary' : ''} onClick={() => setLang('en')}>English</button>
          </div>
        </div>

        <div className="field">
          {s.pieceLabels}
          <div className="row">
            <button
              className={settings.pieceLabels === 'zh' ? 'primary' : ''}
              onClick={() => updateSettings({ pieceLabels: 'zh' })}
            >
              {s.pieceLabelsZh}
            </button>
            <button
              className={settings.pieceLabels === 'both' ? 'primary' : ''}
              onClick={() => updateSettings({ pieceLabels: 'both' })}
            >
              {s.pieceLabelsBoth}
            </button>
          </div>
        </div>

        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={settings.sound}
            onChange={(e) => updateSettings({ sound: e.target.checked })}
          />
          {s.soundOn}
        </label>

        <p className="muted hint-bar" style={{ margin: 0 }}>
          {s.threads}: {engineInfo || '—'}
          {capabilities && !capabilities.crossOriginIsolation ? ` — ${s.singleThreadNotice}` : ''}
        </p>
      </div>
    </div>
  );
};

/** Who you are on this device, and how long that lasts. */
const AccountSection = () => {
  const s = useStore((state) => state.s);
  const user = useStore((state) => state.user);
  const busy = useStore((state) => state.authBusy);
  const error = useStore((state) => state.authError);
  const { claimAccount, signOut, startLink, goto } = useStore.getState();
  const [claiming, setClaiming] = useState(false);
  const [name, setName] = useState(user?.name ?? '');
  const [password, setPassword] = useState('');

  if (!user) {
    return (
      <div className="card stack">
        <strong>{s.account}</strong>
        <button className="primary" onClick={() => goto('auth')}>{s.signIn}</button>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="row">
        <strong>{s.account}</strong>
        <div className="spacer" />
        <span className="muted">
          {s.playingAs}: {user.name}
          {user.guest ? ` · ${s.guestBadge}` : ` · ${user.rating}${user.provisional ? '?' : ''}`}
        </span>
      </div>

      {user.guest && claiming ? (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void claimAccount(name, password).then((ok) => { if (ok) setClaiming(false); });
          }}
        >
          <span className="muted">{s.claimHint}</span>
          <label className="field">
            {s.displayName}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="username" />
          </label>
          <label className="field">
            {s.password}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <span className="muted">{s.passwordHint}</span>
          </label>
          {error ? <div className="error">{error}</div> : null}
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !name || !password}>
              {s.claimAccount}
            </button>
            <button type="button" className="ghost" onClick={() => setClaiming(false)}>{s.cancel}</button>
          </div>
        </form>
      ) : null}

      {user.guest && !claiming ? (
        <div className="row wrap">
          <button className="primary" onClick={() => setClaiming(true)}>{s.claimAccount}</button>
          <button onClick={() => void startLink()}>{s.linkWithPhone}</button>
          <div className="spacer" />
          <button className="ghost" onClick={() => goto('auth')}>{s.signIn}</button>
        </div>
      ) : null}

      {!user.guest ? (
        <div className="row">
          <button className="ghost" onClick={() => void signOut()}>{s.signOut}</button>
        </div>
      ) : null}

      <PersistToggle />
    </div>
  );
};

// ------------------------------------------------------------------ tutorial --

export const TutorialScreen = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const snapshot = useStore((state) => state.snapshot);
  const { goto, startTutorial } = useStore.getState();
  const [lessonId, setLessonId] = useState(LESSONS[0]!.id);
  const [demoIndex, setDemoIndex] = useState(0);
  const [challenge, setChallenge] = useState(false);
  const [solved, setSolved] = useState<boolean | null>(null);

  const lesson = useMemo(() => LESSONS.find((l) => l.id === lessonId)!, [lessonId]);
  const demo = lesson.demos[Math.min(demoIndex, lesson.demos.length - 1)]!;

  useEffect(() => {
    if (challenge) {
      startTutorial(lesson.challenge.fen, null, []);
      setSolved(null);
    } else {
      startTutorial(demo.fen, demo.focus, demo.obstacles ?? []);
    }
  }, [lesson, demo, challenge, startTutorial]);

  useEffect(() => {
    if (!challenge || snapshot.moves.length === 0) return;
    setSolved(lesson.challenge.solutions.includes(snapshot.moves[snapshot.moves.length - 1]!.iccs));
  }, [challenge, lesson, snapshot.moves]);

  return (
    <div className="center-pane">
      <div className="card sheet stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>{s.tutorial}</h2>
          <div className="spacer" />
          <button className="ghost" onClick={() => goto('menu')}>{s.back}</button>
        </div>

        <div className="lesson-nav">
          {LESSONS.map((item) => (
            <button
              key={item.id}
              aria-pressed={item.id === lessonId}
              onClick={() => { setLessonId(item.id); setDemoIndex(0); setChallenge(false); }}
            >
              {item.title[lang]}
            </button>
          ))}
        </div>

        <div>
          <strong style={{ fontSize: 17 }}>{lesson.title[lang]}</strong>
          <div style={{ color: 'var(--accent-hot)' }}>{lesson.summary[lang]}</div>
        </div>

        <ul className="rules">
          {lesson.rules.map((rule, index) => <li key={index}>{rule[lang]}</li>)}
        </ul>

        {challenge ? (
          <div className="stack">
            <div><strong>{s.tryIt}</strong> — {lesson.challenge.prompt[lang]}</div>
            {solved === true ? <div className="good-text">{lesson.challenge.success[lang]}</div> : null}
            {solved === false ? <div className="error">{s.tryAgain}</div> : null}
            <div className="row">
              <button onClick={() => { startTutorial(lesson.challenge.fen, null, []); setSolved(null); }}>
                {s.tryAgain}
              </button>
              <button className="ghost" onClick={() => setChallenge(false)}>{s.back}</button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <div><strong>{demo.caption[lang]}</strong></div>
            {demo.note ? <div className="muted">{demo.note[lang]}</div> : null}
            <div className="row">
              <button disabled={demoIndex === 0} onClick={() => setDemoIndex(demoIndex - 1)}>{s.prevDemo}</button>
              <span className="muted">{demoIndex + 1} / {lesson.demos.length}</span>
              <button
                disabled={demoIndex >= lesson.demos.length - 1}
                onClick={() => setDemoIndex(demoIndex + 1)}
              >
                {s.nextDemo}
              </button>
              <div className="spacer" />
              <button className="primary" onClick={() => setChallenge(true)}>{s.tryIt}</button>
            </div>
          </div>
        )}

        <p className="hint-bar" style={{ margin: 0 }}>{s.tutorialIntro}</p>
      </div>
    </div>
  );
};

// ----------------------------------------------------------------- game view --

export const GameHud = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const snapshot = useStore((state) => state.snapshot);
  const room = useStore((state) => state.room);
  const seat = useStore((state) => state.seat);
  const clocks = useStore((state) => state.clocks);
  const prompt = useStore((state) => state.prompt);
  const awaiting = useStore((state) => state.awaitingUndoReply);
  const ratingDelta = useStore((state) => state.ratingDelta);
  const {
    requestUndo, respondPrompt, resign, offerDraw, requestHint, leaveGame, rematch, recentre,
  } = useStore.getState();
  const [showMoves, setShowMoves] = useState(false);

  const isPvp = snapshot.mode === 'pvp';
  const status = snapshot.over
    ? `${snapshot.over.result === 'draw'
      ? s.draw
      : snapshot.myColor !== null && (snapshot.over.result === 'red' ? 0 : 1) === snapshot.myColor
        ? s.youWin
        : s.youLose} · ${reasonText(snapshot.over.reason, s)}`
    : snapshot.thinking
      ? `${s.aiThinking}…`
      : snapshot.canMove
        ? (snapshot.inCheck ? `${s.yourTurn} · ${s.check}` : s.yourTurn)
        : isPvp && room?.status === 'waiting'
          ? s.waitingForOpponent
          : s.opponentTurn;

  const clockMs = (side: 'red' | 'black') => (side === 'red' ? clocks?.redMs : clocks?.blackMs) ?? 0;
  const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

  return (
    <>
      {prompt ? (
        <div className="center-pane" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 4 }}>
          <div className="card stack" style={{ minWidth: 300 }}>
            <strong>{prompt.kind === 'undo' ? s.undoAsk : s.drawOffered}</strong>
            <span className="muted">{prompt.byName}</span>
            <div className="row">
              <button className="good" onClick={() => respondPrompt(true)}>{s.accept}</button>
              <button className="danger" onClick={() => respondPrompt(false)}>{s.decline}</button>
            </div>
          </div>
        </div>
      ) : null}

      {snapshot.over && snapshot.mode !== 'tutorial' ? (
        <div className="center-pane" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 3 }}>
          <div className="card stack" style={{ minWidth: 320, textAlign: 'center' }}>
            <h2 style={{ margin: 0 }}>{status}</h2>
            {ratingDelta ? (
              <div className={ratingDelta.after >= ratingDelta.before ? 'good-text' : 'error'}>
                {s.ratingChange}: {ratingDelta.before} → {ratingDelta.after}
                {' '}({ratingDelta.after - ratingDelta.before >= 0 ? '+' : ''}{ratingDelta.after - ratingDelta.before})
              </div>
            ) : null}
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="primary" onClick={rematch}>{s.rematch}</button>
              <button onClick={leaveGame}>{s.back}</button>
            </div>
          </div>
        </div>
      ) : null}

      {showMoves ? (
        <div
          className="card"
          style={{ position: 'fixed', right: 16, top: 64, width: 260, zIndex: 2 }}
        >
          <div className="row">
            <strong>{s.moveList}</strong>
            <div className="spacer" />
            <button className="ghost" onClick={() => setShowMoves(false)}>{s.close}</button>
          </div>
          <div className="moves">
            {Array.from({ length: Math.ceil(snapshot.moves.length / 2) }, (_, i) => (
              <div key={i} style={{ display: 'contents' }}>
                <span className="n">{i + 1}.</span>
                <span>{snapshot.moves[i * 2] ? (lang === 'zh' ? snapshot.moves[i * 2]!.zh : snapshot.moves[i * 2]!.en) : ''}</span>
                <span>{snapshot.moves[i * 2 + 1] ? (lang === 'zh' ? snapshot.moves[i * 2 + 1]!.zh : snapshot.moves[i * 2 + 1]!.en) : ''}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <footer className="hud">
        <span className="status">{status}</span>
        {clocks ? (
          <span className="muted">
            {s.red} {fmt(clockMs('red'))} · {s.black} {fmt(clockMs('black'))}
          </span>
        ) : null}
        {room ? <span className="muted">#{room.id}</span> : null}
        <div className="spacer" />

        {seat !== 'spectator' ? (
          <>
            <button disabled={!snapshot.canUndo || awaiting} onClick={requestUndo}>
              {awaiting ? `${s.undo}…` : s.undo}
            </button>
            {!isPvp ? (
              <button disabled={!snapshot.canMove || snapshot.thinking} onClick={requestHint}>{s.hint}</button>
            ) : (
              <button disabled={Boolean(snapshot.over)} onClick={offerDraw}>{s.offerDraw}</button>
            )}
            <button className="danger" disabled={Boolean(snapshot.over)} onClick={resign}>{s.resign}</button>
          </>
        ) : null}
        <button onClick={() => setShowMoves((value) => !value)}>{s.moveList}</button>
        <button className="ghost" onClick={recentre}>{s.recenter}</button>
        <button className="ghost" onClick={leaveGame}>{s.back}</button>
      </footer>
    </>
  );
};

export const Toast = () => {
  const toast = useStore((state) => state.toast);
  if (!toast) return null;
  return <div className={`toast ${toast.kind}`}>{toast.text}</div>;
};

export const RED_COLOR = RED;
