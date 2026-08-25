/**
 * The in-headset interface: everything you can reach without taking the
 * headset off.
 *
 * Layout is written once, in "player space" — the seated player is at +Z looking
 * toward -Z, their right hand is +X. The scene wraps these panels in a group
 * rotated by the seat, so Black gets the identical layout from the other side of
 * the table without a second set of coordinates.
 */
import { useEffect, useMemo, useState } from 'react';
import { LEVELS, levelSpec } from '@ccx/ai';
import {
  BLACK, LESSONS, RED, colorName, type RoomSummary, type TutorialLesson,
} from '@ccx/shared';
import { reasonText, type Lang, type Strings } from '../i18n/index.js';
import type { Snapshot } from '../state/gameController.js';
import { useStore } from '../state/store.js';
import { TABLE_HEIGHT } from './geometry.js';
import { ALL_EMOTES, emoteLabel } from './Avatar.js';
import { Button, Keypad, Label, Meter, PagedList, Panel, Stepper, Toggle, UI } from './ui3d.js';

const PANEL_Y = TABLE_HEIGHT + 0.21;

const clockText = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

/** Evaluation in pawns, from the player's point of view. */
const evalText = (snapshot: Snapshot): string => {
  if (!snapshot.evaluation) return '—';
  if (snapshot.evaluation.mateIn !== null) {
    const n = Math.abs(snapshot.evaluation.mateIn);
    return snapshot.evaluation.mateIn > 0 ? `M${n}` : `-M${n}`;
  }
  const pawns = snapshot.evaluation.score / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(1)}`;
};

// ------------------------------------------------------------------ game HUD --

export const GamePanel = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const snapshot = useStore((state) => state.snapshot);
  const clocks = useStore((state) => state.clocks);
  const room = useStore((state) => state.room);
  const seat = useStore((state) => state.seat);
  const awaitingUndo = useStore((state) => state.awaitingUndoReply);
  const engineInfo = useStore((state) => state.engineInfo);
  const { requestUndo, resign, offerDraw, requestHint, leaveGame } = useStore.getState();

  const isPvp = snapshot.mode === 'pvp';
  const isSpectator = seat === 'spectator';
  const myTurn = snapshot.canMove;

  const status = snapshot.over
    ? resultText(snapshot, s)
    : snapshot.thinking
      ? `${s.aiThinking}…`
      : myTurn
        ? snapshot.inCheck ? `${s.yourTurn} · ${s.check}` : s.yourTurn
        : isPvp && !room?.seats[1] ? s.waitingForOpponent : s.opponentTurn;

  return (
    <Panel width={0.30} height={0.40} position={[0.40, PANEL_Y, 0.10]} rotation={[-0.22, -0.62, 0]}>
      <Label text={status} size={0.019} align="center" weight={700} position={[0, 0.166, 0.002]} />

      {clocks ? (
        <group position={[0, 0.126, 0.002]}>
          <Label
            text={`${s.red} ${clockText(clocks.redMs)}`}
            size={0.015}
            align="left"
            color={clocks.running === 'red' ? '#ffb4a0' : UI.textDim}
            position={[-0.13, 0, 0]}
          />
          <Label
            text={`${clockText(clocks.blackMs)} ${s.black}`}
            size={0.015}
            align="right"
            color={clocks.running === 'black' ? '#b9c8ff' : UI.textDim}
            position={[0.13, 0, 0]}
          />
        </group>
      ) : null}

      {snapshot.mode === 'ai' ? (
        <group position={[0, 0.104, 0.002]}>
          <Label
            text={`${levelSpec(snapshot.aiLevel).label[lang]} · ${evalText(snapshot)}`}
            size={0.013}
            align="center"
            color={UI.textDim}
          />
          <group position={[0, -0.018, 0]}>
            <Meter
              value={0.5 + Math.max(-0.5, Math.min(0.5, (snapshot.evaluation?.score ?? 0) / 1600))}
              width={0.2}
              color={(snapshot.evaluation?.score ?? 0) >= 0 ? '#3fbf6f' : '#d94f3d'}
            />
          </group>
        </group>
      ) : null}

      <MoveTicker snapshot={snapshot} lang={lang} label={s.moveList} position={[0, 0.028, 0.002]} />

      {isSpectator ? (
        <Button label={s.leaveRoom} width={0.24} height={0.04} variant="ghost" onClick={leaveGame} position={[0, -0.155, 0]} />
      ) : (
        <group>
          <Button
            label={awaitingUndo ? `${s.undo}…` : s.undo}
            width={0.13}
            height={0.044}
            disabled={!snapshot.canUndo || awaitingUndo}
            onClick={requestUndo}
            position={[-0.072, -0.072, 0]}
          />
          <Button
            label={s.hint}
            width={0.13}
            height={0.044}
            disabled={!myTurn || snapshot.thinking || isPvp}
            onClick={requestHint}
            position={[0.072, -0.072, 0]}
          />
          <Button
            label={s.offerDraw}
            width={0.13}
            height={0.044}
            disabled={!isPvp || Boolean(snapshot.over)}
            onClick={offerDraw}
            position={[-0.072, -0.124, 0]}
          />
          <Button
            label={s.resign}
            width={0.13}
            height={0.044}
            variant="danger"
            disabled={Boolean(snapshot.over)}
            onClick={resign}
            position={[0.072, -0.124, 0]}
          />
          <Button label={s.back} width={0.272} height={0.036} variant="ghost" onClick={leaveGame} position={[0, -0.172, 0]} />
        </group>
      )}

      {snapshot.mode === 'ai' && engineInfo ? (
        <Label text={engineInfo} size={0.009} align="center" color={UI.disabled} position={[0, -0.192, 0.002]} />
      ) : null}
    </Panel>
  );
};

const MoveTicker = ({
  snapshot, lang, label, position,
}: { snapshot: Snapshot; lang: Lang; label: string; position: [number, number, number] }) => {
  const recent = snapshot.moves.slice(-8);
  const offset = snapshot.moves.length - recent.length;
  return (
    <group position={position}>
      <Label text={label} size={0.011} color={UI.textDim} position={[-0.13, 0.052, 0]} />
      {recent.map((move, index) => {
        const ply = offset + index;
        const text = `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '…'} ${lang === 'zh' ? move.zh : move.en}`;
        return (
          <Label
            key={ply}
            text={text}
            size={0.0115}
            color={index === recent.length - 1 ? UI.text : UI.textDim}
            position={[-0.13, 0.03 - index * 0.0155, 0]}
          />
        );
      })}
    </group>
  );
};

const resultText = (snapshot: Snapshot, s: Strings): string => {
  if (!snapshot.over) return '';
  const { result, reason } = snapshot.over;
  const outcome = result === 'draw'
    ? s.draw
    : snapshot.myColor === null
      ? (result === 'red' ? s.red : s.black)
      : (result === 'red' ? RED : BLACK) === snapshot.myColor ? s.youWin : s.youLose;
  return `${outcome} · ${reasonText(reason, s)}`;
};

// ------------------------------------------------------------------- prompts --

/**
 * 悔棋 and draw requests. This is the human-versus-human half of the take-back
 * rule: the request floats over the board and the game waits until the opponent
 * answers or the server's timeout expires.
 */
export const PromptOverlay = () => {
  const prompt = useStore((state) => state.prompt);
  const s = useStore((state) => state.s);
  const respond = useStore((state) => state.respondPrompt);
  if (!prompt) return null;

  return (
    <Panel width={0.30} height={0.13} position={[0, TABLE_HEIGHT + 0.32, 0.06]} rotation={[-0.2, 0, 0]} color="#2a2119">
      <Label
        text={prompt.kind === 'undo' ? s.undoAsk : s.drawOffered}
        size={0.017}
        align="center"
        weight={600}
        position={[0, 0.032, 0.002]}
      />
      <Label text={prompt.byName} size={0.013} align="center" color={UI.textDim} position={[0, 0.008, 0.002]} />
      <Button label={s.accept} width={0.12} height={0.04} variant="good" onClick={() => respond(true)} position={[-0.066, -0.032, 0]} />
      <Button label={s.decline} width={0.12} height={0.04} variant="danger" onClick={() => respond(false)} position={[0.066, -0.032, 0]} />
    </Panel>
  );
};

export const ResultPanel = () => {
  const snapshot = useStore((state) => state.snapshot);
  const s = useStore((state) => state.s);
  const ratingDelta = useStore((state) => state.ratingDelta);
  const rematchRequested = useStore((state) => state.rematchRequested);
  const { rematch, leaveGame } = useStore.getState();
  if (!snapshot.over || snapshot.mode === 'tutorial') return null;

  const delta = ratingDelta ? ratingDelta.after - ratingDelta.before : null;

  return (
    <Panel width={0.32} height={0.17} position={[0, TABLE_HEIGHT + 0.34, -0.02]} rotation={[-0.16, 0, 0]} color="#241d17">
      <Label text={resultText(snapshot, s)} size={0.022} align="center" weight={700} position={[0, 0.05, 0.002]} />
      {delta !== null ? (
        <Label
          text={`${s.ratingChange}  ${ratingDelta!.before} → ${ratingDelta!.after}  (${delta >= 0 ? '+' : ''}${delta})`}
          size={0.013}
          align="center"
          color={delta >= 0 ? '#8fd6a4' : '#e39d92'}
          position={[0, 0.022, 0.002]}
        />
      ) : null}
      <Button
        label={rematchRequested ? s.waitingRematch : s.rematch}
        width={0.14}
        height={0.044}
        variant="primary"
        disabled={rematchRequested}
        onClick={rematch}
        position={[-0.077, -0.032, 0]}
      />
      <Button label={s.back} width={0.14} height={0.044} onClick={leaveGame} position={[0.077, -0.032, 0]} />
    </Panel>
  );
};

/** Quick phrases, because typing in a headset is not worth anyone's time. */
export const EmoteBar = () => {
  const lang = useStore((state) => state.lang);
  const room = useStore((state) => state.room);
  const sendEmote = useStore((state) => state.sendEmote);
  if (!room) return null;

  const shown = ALL_EMOTES.slice(0, 6);
  return (
    <group position={[0, TABLE_HEIGHT + 0.05, 0.34]} rotation={[-0.9, 0, 0]}>
      {shown.map((emote, index) => (
        <Button
          key={emote}
          label={emoteLabel(emote, lang)}
          width={0.075}
          height={0.03}
          textSize={0.011}
          variant="ghost"
          onClick={() => sendEmote(emote)}
          position={[(index - (shown.length - 1) / 2) * 0.08, 0, 0]}
        />
      ))}
    </group>
  );
};

// --------------------------------------------------------------- main menu ----

export const MenuPanel = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const user = useStore((state) => state.user);
  const screen = useStore((state) => state.screen);
  const { goto, openLobby, setLang, startLink } = useStore.getState();
  if (screen !== 'menu') return null;

  return (
    <Panel width={0.36} height={0.40} position={[0, TABLE_HEIGHT + 0.30, -0.04]} rotation={[-0.18, 0, 0]}>
      <Label text={s.appTitle} size={0.028} align="center" weight={700} position={[0, 0.158, 0.002]} />
      <Label text={s.appSubtitle} size={0.012} align="center" color={UI.textDim} position={[0, 0.134, 0.002]} />

      <Button label={s.playAi} sub={s.playAiSub} width={0.32} height={0.05} variant="primary" onClick={() => goto('ai-setup')} position={[0, 0.08, 0]} />
      <Button label={s.playHuman} sub={s.playHumanSub} width={0.32} height={0.05} onClick={openLobby} position={[0, 0.022, 0]} />
      <Button label={s.tutorial} sub={s.tutorialSub} width={0.32} height={0.05} onClick={() => goto('tutorial')} position={[0, -0.036, 0]} />

      {/* Only offered to guests, and only ever as a phone hand-off: there is no
          version of this that asks someone to type a password in here. */}
      {user?.guest ? (
        <Button
          label={s.linkWithPhone}
          sub={s.linkWithPhoneSub}
          width={0.32}
          height={0.042}
          textSize={0.013}
          onClick={() => void startLink()}
          position={[0, -0.092, 0]}
        />
      ) : null}

      <group position={[0, -0.156, 0]}>
        <Button label="中文" width={0.07} height={0.032} textSize={0.013} variant={lang === 'zh' ? 'primary' : 'ghost'} onClick={() => setLang('zh')} position={[-0.115, 0, 0]} />
        <Button label="EN" width={0.07} height={0.032} textSize={0.013} variant={lang === 'en' ? 'primary' : 'ghost'} onClick={() => setLang('en')} position={[-0.038, 0, 0]} />
        <Label
          text={user ? `${user.name} · ${user.rating}${user.provisional ? '?' : ''}` : ''}
          size={0.012}
          align="right"
          color={UI.textDim}
          position={[0.155, 0, 0.002]}
        />
      </group>
    </Panel>
  );
};

/**
 * Pairing, from inside the headset.
 *
 * The player reads eight characters off this panel and types them on their
 * phone. It cannot be a QR code: the phone's camera cannot see a display that
 * is strapped to the player's face. What it can do is lean on passthrough —
 * with the world visible, someone can read this panel and use their real phone
 * without breaking the session, which is the whole reason this flow exists
 * rather than "take the headset off and sign in on a laptop".
 */
export const LinkPanel = () => {
  const s = useStore((state) => state.s);
  const screen = useStore((state) => state.screen);
  const link = useStore((state) => state.link);
  const busy = useStore((state) => state.authBusy);
  const { startLink, cancelLink, goto } = useStore.getState();
  const remaining = useTicker(link?.status === 'pending');

  if (screen !== 'link') return null;

  const msLeft = link ? Math.max(0, link.expiresAt - remaining) : 0;
  const status = !link
    ? '…'
    : link.status === 'expired'
      ? s.linkExpired
      : link.status === 'denied'
        ? s.linkDenied
        : `${s.linkWaiting}  ${s.linkExpiresIn.replace('{time}', clockText(msLeft))}`;

  return (
    <Panel width={0.40} height={0.34} position={[0, TABLE_HEIGHT + 0.30, -0.04]} rotation={[-0.18, 0, 0]}>
      <Label text={s.linkTitle} size={0.022} align="center" weight={700} position={[0, 0.128, 0.002]} />

      <Label text={s.linkStep1} size={0.012} align="center" color={UI.textDim} position={[0, 0.094, 0.002]} />
      <Label text={link?.url ?? ''} size={0.016} align="center" weight={600} position={[0, 0.068, 0.002]} />

      <Label text={s.linkStep2} size={0.012} align="center" color={UI.textDim} position={[0, 0.032, 0.002]} />
      <Panel width={0.30} height={0.062} color="#100d0b" depth={0.004} position={[0, -0.014, 0]}>
        <Label
          text={link?.userCode ?? '––––'}
          size={0.038}
          align="center"
          weight={700}
          color={UI.accentHot}
          position={[0, 0, 0.002]}
        />
      </Panel>

      <Label text={status} size={0.012} align="center" color={UI.textDim} position={[0, -0.062, 0.002]} />

      {!link || link.status !== 'pending' ? (
        <Button
          label={s.linkRetry}
          width={0.16}
          height={0.04}
          variant="primary"
          disabled={busy}
          onClick={() => void startLink()}
          position={[-0.09, -0.104, 0]}
        />
      ) : null}
      <Button
        label={s.cancel}
        width={0.16}
        height={0.04}
        variant="ghost"
        onClick={() => { cancelLink(); goto('menu'); }}
        position={[!link || link.status !== 'pending' ? 0.09 : 0, -0.104, 0]}
      />

      <Label
        text={s.linkPassthroughHint}
        size={0.0105}
        align="center"
        color={UI.textDim}
        wrapAt={0.36}
        maxWidth={0.36}
        position={[0, -0.148, 0.002]}
      />
    </Panel>
  );
};

/**
 * A once-a-second re-render, returning `Date.now()`. The flat interface has its
 * own copy of this; sharing one would mean an import between the DOM screens and
 * the 3D panels, and those two deliberately do not depend on each other.
 */
const useTicker = (running: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
};

export const AiSetupPanel = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const screen = useStore((state) => state.screen);
  const engineReady = useStore((state) => state.engineReady);
  const { goto, startAiGame } = useStore.getState();
  const [level, setLevel] = useState(4);
  const [side, setSide] = useState<'red' | 'black' | 'random'>('red');
  if (screen !== 'ai-setup') return null;

  const spec = LEVELS[level - 1]!;

  return (
    <Panel width={0.34} height={0.30} position={[0, TABLE_HEIGHT + 0.29, -0.04]} rotation={[-0.18, 0, 0]}>
      <Label text={s.playAi} size={0.022} align="center" weight={700} position={[0, 0.112, 0.002]} />

      <Stepper
        label={s.difficulty}
        value={level}
        display={`${level} · ${spec.label[lang]}`}
        min={1}
        max={8}
        onChange={setLevel}
        width={0.28}
        position={[0, 0.05, 0.002]}
      />
      <Label
        text={`${s.aiStrength} ${spec.rating} · ${spec.depth} ply · ${(spec.timeMs / 1000).toFixed(1)}s`}
        size={0.011}
        align="center"
        color={UI.textDim}
        position={[0, 0.012, 0.002]}
      />

      <Label text={s.yourSide} size={0.013} color={UI.textDim} position={[-0.14, -0.022, 0.002]} />
      <group position={[0, -0.05, 0]}>
        {(['red', 'black', 'random'] as const).map((option, index) => (
          <Button
            key={option}
            label={option === 'red' ? s.red : option === 'black' ? s.black : s.randomSide}
            width={0.092}
            height={0.038}
            textSize={0.013}
            variant={side === option ? 'primary' : 'ghost'}
            onClick={() => setSide(option)}
            position={[(index - 1) * 0.1, 0, 0]}
          />
        ))}
      </group>

      <Button
        label={s.startGame}
        width={0.3}
        height={0.046}
        variant="primary"
        disabled={!engineReady}
        onClick={() => void startAiGame(level, side)}
        position={[0, -0.104, 0]}
      />
      <Button label={s.back} width={0.3} height={0.03} variant="ghost" textSize={0.012} onClick={() => goto('menu')} position={[0, -0.14, 0]} />
    </Panel>
  );
};

// ------------------------------------------------------------------- lobby ----

export const LobbyPanel = () => {
  const s = useStore((state) => state.s);
  const screen = useStore((state) => state.screen);
  const rooms = useStore((state) => state.rooms);
  const { goto, joinRoom, createRoom } = useStore.getState();
  const [page, setPage] = useState(0);
  const [passcodeFor, setPasscodeFor] = useState<RoomSummary | null>(null);
  const [passcode, setPasscode] = useState('');
  const [creating, setCreating] = useState(false);

  if (screen !== 'lobby') return null;

  if (passcodeFor) {
    return (
      <group position={[0, TABLE_HEIGHT + 0.30, -0.04]} rotation={[-0.18, 0, 0]}>
        <Keypad
          title={`${s.enterPasscode} · ${passcodeFor.name}`}
          value={passcode}
          onChange={setPasscode}
          onSubmit={() => {
            joinRoom(passcodeFor.id, passcode);
            setPasscodeFor(null);
            setPasscode('');
          }}
          onCancel={() => { setPasscodeFor(null); setPasscode(''); }}
        />
      </group>
    );
  }

  if (creating) return <CreateRoomPanel onDone={() => setCreating(false)} />;

  return (
    <Panel width={0.42} height={0.34} position={[0, TABLE_HEIGHT + 0.30, -0.04]} rotation={[-0.18, 0, 0]}>
      <Label text={s.rooms} size={0.02} align="center" weight={700} position={[0, 0.14, 0.002]} />

      <PagedList
        items={rooms}
        perPage={4}
        page={page}
        onPage={setPage}
        rowHeight={0.05}
        width={0.38}
        empty={s.noRooms}
        position={[0, 0.038, 0.002]}
        render={(room) => (
          <group>
            <Label text={room.name} size={0.014} weight={600} position={[-0.185, 0.009, 0]} />
            <Label
              text={[
                room.status === 'waiting' ? s.waiting : room.status === 'playing' ? s.playing : s.finished,
                room.hasPasscode ? `· ${s.locked}` : '',
                room.rated ? '· ★' : '',
                `· ${room.host.name} ${room.host.rating}`,
              ].filter(Boolean).join(' ')}
              size={0.0105}
              color={UI.textDim}
              position={[-0.185, -0.011, 0]}
            />
            <Button
              label={room.status === 'waiting' ? s.join : s.spectate}
              width={0.062}
              height={0.032}
              textSize={0.012}
              variant={room.status === 'waiting' ? 'primary' : 'ghost'}
              onClick={() => {
                if (room.hasPasscode) { setPasscodeFor(room); return; }
                joinRoom(room.id, undefined, room.status !== 'waiting');
              }}
              position={[0.155, 0, 0]}
            />
          </group>
        )}
      />

      <Button label={s.createRoom} width={0.19} height={0.042} variant="primary" onClick={() => setCreating(true)} position={[-0.1, -0.132, 0]} />
      <Button label={s.back} width={0.19} height={0.042} variant="ghost" onClick={() => goto('menu')} position={[0.1, -0.132, 0]} />
    </Panel>
  );
};

const CreateRoomPanel = ({ onDone }: { onDone: () => void }) => {
  const s = useStore((state) => state.s);
  const user = useStore((state) => state.user);
  const createRoom = useStore((state) => state.createRoom);
  const [rated, setRated] = useState(true);
  const [open, setOpen] = useState(true);
  const [side, setSide] = useState<'red' | 'black' | 'random'>('random');
  const [minutes, setMinutes] = useState(0);
  const [usePasscode, setUsePasscode] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [keypad, setKeypad] = useState(false);

  if (keypad) {
    return (
      <group position={[0, TABLE_HEIGHT + 0.30, -0.04]} rotation={[-0.18, 0, 0]}>
        <Keypad
          title={s.passcodeLabel}
          value={passcode}
          onChange={setPasscode}
          onSubmit={() => { setUsePasscode(true); setKeypad(false); }}
          onCancel={() => { setPasscode(''); setUsePasscode(false); setKeypad(false); }}
        />
      </group>
    );
  }

  const name = `${user?.name ?? 'Player'} · ${s.roomName}`;

  return (
    <Panel width={0.36} height={0.32} position={[0, TABLE_HEIGHT + 0.30, -0.04]} rotation={[-0.18, 0, 0]}>
      <Label text={s.createRoom} size={0.02} align="center" weight={700} position={[0, 0.13, 0.002]} />

      <Toggle label={s.ratedGame} value={rated} onChange={setRated} width={0.3} position={[0, 0.086, 0.002]} />
      <Toggle label={s.allowSpectators} value={open} onChange={setOpen} width={0.3} position={[0, 0.05, 0.002]} />
      <Toggle
        label={`${s.passcodeLabel}${usePasscode && passcode ? ` · ${'•'.repeat(passcode.length)}` : ''}`}
        value={usePasscode && passcode.length >= 4}
        onChange={(value) => {
          if (value) setKeypad(true);
          else { setUsePasscode(false); setPasscode(''); }
        }}
        width={0.3}
        position={[0, 0.014, 0.002]}
      />

      <Label text={s.yourSide} size={0.012} color={UI.textDim} position={[-0.15, -0.022, 0.002]} />
      <group position={[0, -0.05, 0]}>
        {(['red', 'black', 'random'] as const).map((option, index) => (
          <Button
            key={option}
            label={option === 'red' ? s.red : option === 'black' ? s.black : s.randomSide}
            width={0.094}
            height={0.036}
            textSize={0.012}
            variant={side === option ? 'primary' : 'ghost'}
            onClick={() => setSide(option)}
            position={[(index - 1) * 0.102, 0, 0]}
          />
        ))}
      </group>

      <Stepper
        label={s.timeControl}
        value={minutes}
        display={minutes === 0 ? s.untimed : `${minutes} min +3s`}
        min={0}
        max={30}
        onChange={setMinutes}
        width={0.28}
        position={[0, -0.096, 0.002]}
      />

      <Button
        label={s.createRoom}
        width={0.16}
        height={0.042}
        variant="primary"
        onClick={() => {
          createRoom({
            name,
            passcode: usePasscode && passcode.length >= 4 ? passcode : undefined,
            side,
            rated,
            open,
            timeControl: minutes > 0 ? { initialSeconds: minutes * 60, incrementSeconds: 3 } : null,
          });
          onDone();
        }}
        position={[-0.085, -0.14, 0]}
      />
      <Button label={s.back} width={0.16} height={0.042} variant="ghost" onClick={onDone} position={[0.085, -0.14, 0]} />
    </Panel>
  );
};

/** Shown while sitting in a room that has not filled up yet. */
export const RoomWaitingPanel = () => {
  const s = useStore((state) => state.s);
  const room = useStore((state) => state.room);
  const snapshot = useStore((state) => state.snapshot);
  const leaveRoom = useStore((state) => state.leaveRoom);
  if (!room || room.status !== 'waiting' || snapshot.moves.length > 0) return null;

  return (
    <Panel width={0.26} height={0.13} position={[0, TABLE_HEIGHT + 0.30, -0.10]} rotation={[-0.18, 0, 0]}>
      <Label text={s.waitingForOpponent} size={0.015} align="center" position={[0, 0.036, 0.002]} />
      <Label text={`${s.roomCode}`} size={0.011} align="center" color={UI.textDim} position={[0, 0.012, 0.002]} />
      <Label text={room.id} size={0.026} align="center" weight={700} color={UI.accentHot} position={[0, -0.014, 0.002]} />
      <Button label={s.leaveRoom} width={0.16} height={0.03} variant="ghost" textSize={0.012} onClick={leaveRoom} position={[0, -0.046, 0]} />
    </Panel>
  );
};

// ---------------------------------------------------------------- tutorial ----

export const TutorialPanel = () => {
  const s = useStore((state) => state.s);
  const lang = useStore((state) => state.lang);
  const screen = useStore((state) => state.screen);
  const snapshot = useStore((state) => state.snapshot);
  const { goto, startTutorial } = useStore.getState();

  const [lessonId, setLessonId] = useState<string | null>(null);
  const [demoIndex, setDemoIndex] = useState(0);
  const [challenge, setChallenge] = useState(false);
  const [solved, setSolved] = useState<boolean | null>(null);

  const lesson = useMemo(() => LESSONS.find((l) => l.id === lessonId) ?? null, [lessonId]);

  // Load whichever board the current step calls for.
  useEffect(() => {
    if (screen !== 'tutorial' || !lesson) return;
    if (challenge) {
      startTutorial(lesson.challenge.fen, null, []);
      setSolved(null);
    } else {
      const demo = lesson.demos[demoIndex]!;
      startTutorial(demo.fen, demo.focus, demo.obstacles ?? []);
    }
  }, [screen, lesson, demoIndex, challenge, startTutorial]);

  // Grade the challenge as soon as a move is made.
  useEffect(() => {
    if (!challenge || !lesson || snapshot.moves.length === 0) return;
    const played = snapshot.moves[snapshot.moves.length - 1]!.iccs;
    setSolved(lesson.challenge.solutions.includes(played));
  }, [challenge, lesson, snapshot.moves]);

  if (screen !== 'tutorial') return null;

  if (!lesson) {
    return (
      <Panel width={0.34} height={0.32} position={[0, TABLE_HEIGHT + 0.30, -0.04]} rotation={[-0.18, 0, 0]}>
        <Label text={s.tutorial} size={0.021} align="center" weight={700} position={[0, 0.132, 0.002]} />
        <Label text={s.tutorialIntro} size={0.0105} align="center" color={UI.textDim} wrapAt={0.3} position={[0, 0.104, 0.002]} />
        {LESSONS.map((item, index) => (
          <Button
            key={item.id}
            label={item.title[lang]}
            width={0.3}
            height={0.032}
            textSize={0.013}
            onClick={() => { setLessonId(item.id); setDemoIndex(0); setChallenge(false); }}
            position={[0, 0.056 - index * 0.037, 0]}
          />
        ))}
        <Button label={s.back} width={0.3} height={0.03} variant="ghost" textSize={0.012} onClick={() => goto('menu')} position={[0, -0.145, 0]} />
      </Panel>
    );
  }

  return (
    <group>
      <LessonPanel
        lesson={lesson}
        lang={lang}
        s={s}
        demoIndex={demoIndex}
        challenge={challenge}
        solved={solved}
        onDemo={setDemoIndex}
        onChallenge={setChallenge}
        onBack={() => { setLessonId(null); setChallenge(false); setSolved(null); }}
        onRetry={() => { startTutorial(lesson.challenge.fen, null, []); setSolved(null); }}
      />
    </group>
  );
};

const LessonPanel = ({
  lesson, lang, s, demoIndex, challenge, solved, onDemo, onChallenge, onBack, onRetry,
}: {
  lesson: TutorialLesson;
  lang: Lang;
  s: Strings;
  demoIndex: number;
  challenge: boolean;
  solved: boolean | null;
  onDemo: (index: number) => void;
  onChallenge: (value: boolean) => void;
  onBack: () => void;
  onRetry: () => void;
}) => {
  const demo = lesson.demos[demoIndex]!;

  return (
    <group>
      {/* Rules, on the player's left. */}
      <Panel width={0.30} height={0.34} position={[-0.42, PANEL_Y + 0.02, 0.08]} rotation={[-0.22, 0.62, 0]}>
        <Label text={lesson.title[lang]} size={0.022} weight={700} position={[-0.13, 0.14, 0.002]} />
        <Label text={lesson.summary[lang]} size={0.0115} color={UI.accentHot} wrapAt={0.26} position={[-0.13, 0.108, 0.002]} />
        <group position={[0, 0.06, 0.002]}>
          {lesson.rules.map((rule, index) => (
            <Label
              key={index}
              text={`· ${rule[lang]}`}
              size={0.0105}
              color={UI.textDim}
              wrapAt={0.26}
              lineHeight={1.45}
              position={[-0.13, -index * 0.048, 0]}
            />
          ))}
        </group>
        <Button label={s.back} width={0.26} height={0.032} variant="ghost" textSize={0.012} onClick={onBack} position={[0, -0.148, 0]} />
      </Panel>

      {/* Step control, on the player's right. */}
      <Panel width={0.28} height={0.24} position={[0.42, PANEL_Y, 0.08]} rotation={[-0.22, -0.62, 0]}>
        {challenge ? (
          <group>
            <Label text={s.tryIt} size={0.017} align="center" weight={700} position={[0, 0.086, 0.002]} />
            <Label text={lesson.challenge.prompt[lang]} size={0.0115} align="center" wrapAt={0.24} position={[0, 0.05, 0.002]} />
            {solved === true ? (
              <Label text={lesson.challenge.success[lang]} size={0.011} align="center" color="#8fd6a4" wrapAt={0.24} position={[0, 0.002, 0.002]} />
            ) : null}
            {solved === false ? (
              <Label text={s.tryAgain} size={0.013} align="center" color="#e39d92" position={[0, 0.004, 0.002]} />
            ) : null}
            <Button label={s.tryAgain} width={0.24} height={0.036} variant="ghost" textSize={0.012} onClick={onRetry} position={[0, -0.05, 0]} />
            <Button label={s.back} width={0.24} height={0.036} textSize={0.012} onClick={() => onChallenge(false)} position={[0, -0.092, 0]} />
          </group>
        ) : (
          <group>
            <Label text={demo.caption[lang]} size={0.0125} align="center" weight={600} wrapAt={0.24} position={[0, 0.082, 0.002]} />
            {demo.note ? (
              <Label text={demo.note[lang]} size={0.0105} align="center" color={UI.textDim} wrapAt={0.24} position={[0, 0.036, 0.002]} />
            ) : null}
            <Label
              text={`${demoIndex + 1} / ${lesson.demos.length}`}
              size={0.011}
              align="center"
              color={UI.textDim}
              position={[0, -0.022, 0.002]}
            />
            <Button
              label="◀"
              width={0.05}
              height={0.036}
              textSize={0.014}
              disabled={demoIndex === 0}
              onClick={() => onDemo(demoIndex - 1)}
              position={[-0.08, -0.056, 0]}
            />
            <Button
              label="▶"
              width={0.05}
              height={0.036}
              textSize={0.014}
              disabled={demoIndex >= lesson.demos.length - 1}
              onClick={() => onDemo(demoIndex + 1)}
              position={[0.08, -0.056, 0]}
            />
            <Button label={s.tryIt} width={0.09} height={0.036} variant="primary" textSize={0.012} onClick={() => onChallenge(true)} position={[0, -0.056, 0]} />
          </group>
        )}
      </Panel>
    </group>
  );
};

export const colorLabel = colorName;
