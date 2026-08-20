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
import { useStore } from '../state/store.js';
import type { Store } from '../xr/XRApp.js';

// ------------------------------------------------------------------- helpers --

export const useXRMode = (store: Store): XRSessionMode | null =>
  useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState().mode,
    () => null,
  );

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
          {user.name} · {user.rating}{user.provisional ? '?' : ''}
        </button>
      ) : null}
      {user ? <button className="ghost" onClick={signOut}>{s.signOut}</button> : null}
    </header>
  );
};

// ---------------------------------------------------------------------- auth --

export const AuthScreen = () => {
  const s = useStore((state) => state.s);
  const busy = useStore((state) => state.authBusy);
  const error = useStore((state) => state.authError);
  const capabilities = useStore((state) => state.capabilities);
  const { signIn, signUp, playAsGuest } = useStore.getState();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void (mode === 'in' ? signIn(name, password) : signUp(name, password));
  };

  return (
    <div className="center-pane">
      <form className="card sheet stack" onSubmit={submit}>
        <h2 style={{ margin: 0 }}>{mode === 'in' ? s.signIn : s.signUp}</h2>
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
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{s.guestNotice}</p>
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------- menu --

export const MenuScreen = () => {
  const s = useStore((state) => state.s);
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
