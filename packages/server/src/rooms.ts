/**
 * Authoritative room and match state.
 *
 * The server owns the position. A client's move is a *request*: it is replayed
 * through the same rules engine the client runs, and only the server's copy
 * counts. That keeps a modified client from cheating in human-vs-human play,
 * which is the whole reason PvP games are the ones that carry a rating.
 *
 * 悔棋 (undo) is asymmetric on purpose. Against the AI the client handles it
 * locally and instantly, because there is nobody to wrong. Against a human it
 * is a request the opponent must accept, and accepting it makes the game
 * unrated by default.
 */
import {
  BLACK, ERROR_CODES, Position, RED, START_FEN, aiRating, describeMove, iccsToMove,
  isProvisional, updateRating,
  type Clocks, type Color, type Emote, type GameOver, type GameState, type MoveRecord,
  type PublicUser, type RatingChange, type RoomSummary, type Score, type ServerMessage,
  type TimeControl,
} from '@ccx/shared';
import { hashPasscode, newGameId, newRoomId, passcodeMatches } from './auth.js';
import type { Config, Logger } from './config.js';
import type { Store, UserRow } from './db.js';

/** How long a disconnected player's seat is held before they forfeit. */
const RECONNECT_GRACE_MS = 60_000;

export interface Client {
  readonly id: string;
  userId: string;
  name: string;
  ip: string;
  roomId: string | null;
  lobby: boolean;
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
  /** Token bucket for ordinary messages. */
  budget: number;
  budgetAt: number;
  /** Separate, looser bucket for pose/grab streaming. */
  poseBudget: number;
  poseBudgetAt: number;
  lastAiReportAt: number;
}

interface Session {
  id: string;
  position: Position;
  startFen: string;
  moves: MoveRecord[];
  /** Clock state before each ply, so an accepted undo restores it exactly. */
  clockHistory: Array<{ redMs: number; blackMs: number }>;
  clocks: Clocks | null;
  pendingUndo: { by: Color; plies: number; timer: NodeJS.Timeout } | null;
  pendingDraw: { by: Color } | null;
  undosAccepted: number;
  flagTimer: NodeJS.Timeout | null;
  startedAt: number;
  lastMoveAt: number;
  over: GameOver | null;
  rematchVotes: Set<string>;
}

interface Room {
  id: string;
  name: string;
  passcodeHash: string | null;
  rated: boolean;
  open: boolean;
  timeControl: TimeControl | null;
  hostId: string;
  /** Seated user ids, [red, black]. */
  seats: [string | null, string | null];
  members: Set<Client>;
  session: Session | null;
  status: 'waiting' | 'playing' | 'finished';
  createdAt: number;
  lastActivity: number;
  /** Forfeit timers for seats whose player dropped mid-game. */
  graceTimers: Map<string, NodeJS.Timeout>;
}

export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly clients = new Set<Client>();
  private lobbyDirty = false;

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  // ------------------------------------------------------------- lifecycle --

  addClient(client: Client): void {
    this.clients.add(client);
    this.store.touchUser(client.userId);
  }

  removeClient(client: Client): void {
    this.clients.delete(client);
    const room = client.roomId ? this.rooms.get(client.roomId) : null;
    if (!room) return;
    room.members.delete(client);
    client.roomId = null;

    const seat = this.seatOf(room, client.userId);
    if (seat !== null && room.status === 'playing') {
      // Hold the seat briefly: headsets drop Wi-Fi, and losing a rated game to
      // a network blip would be worse than making the opponent wait a minute.
      const timer = setTimeout(() => {
        room.graceTimers.delete(client.userId);
        if (room.status !== 'playing') return;
        this.endGame(room, {
          result: seat === RED ? 'black' : 'red',
          reason: 'abandoned',
        });
      }, RECONNECT_GRACE_MS);
      room.graceTimers.set(client.userId, timer);
      this.broadcastRoom(room);
    } else if (seat !== null) {
      room.seats[seat] = null;
    }

    this.reapIfEmpty(room);
    this.markLobbyDirty();
  }

  /** Periodic housekeeping: idle rooms, stale guests. */
  sweep(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const idle = now - room.lastActivity;
      const empty = room.members.size === 0;
      if (empty && idle > 60_000) {
        this.destroyRoom(room);
      } else if (idle > this.config.roomIdleMs && room.status !== 'playing') {
        this.destroyRoom(room);
      }
    }
    this.flushLobby();
  }

  stats(): { rooms: number; clients: number; playing: number } {
    let playing = 0;
    for (const room of this.rooms.values()) if (room.status === 'playing') playing++;
    return { rooms: this.rooms.size, clients: this.clients.size, playing };
  }

  // ------------------------------------------------------------- messaging --

  private error(client: Client, code: string, message: string): void {
    client.send({ t: 'error', code, message });
  }

  private publicUser(user: UserRow): PublicUser {
    return {
      id: user.id,
      name: user.name,
      rating: Math.round(user.rating),
      rd: Math.round(user.rd),
      provisional: isProvisional({ rating: user.rating, rd: user.rd, volatility: user.volatility }),
      guest: user.guest === 1,
    };
  }

  private publicUserById(id: string | null): PublicUser | null {
    if (!id) return null;
    const row = this.store.userById(id);
    return row ? this.publicUser(row) : null;
  }

  roomSummary(room: Room): RoomSummary {
    const host = this.publicUserById(room.hostId);
    let spectators = 0;
    for (const member of room.members) {
      if (this.seatOf(room, member.userId) === null) spectators++;
    }
    return {
      id: room.id,
      name: room.name,
      hasPasscode: room.passcodeHash !== null,
      rated: room.rated,
      open: room.open,
      timeControl: room.timeControl,
      host: host ?? {
        id: room.hostId, name: '—', rating: 1500, rd: 350, provisional: true, guest: true,
      },
      seats: [this.publicUserById(room.seats[RED]), this.publicUserById(room.seats[BLACK])],
      spectators,
      status: room.status,
      createdAt: room.createdAt,
    };
  }

  private lobbyRooms(): RoomSummary[] {
    return [...this.rooms.values()]
      .filter((room) => room.status !== 'finished' || room.members.size > 0)
      .sort((a, b) => {
        // Rooms waiting for an opponent first — that is what a browsing player wants.
        const rank = (r: Room) => (r.status === 'waiting' ? 0 : 1);
        return rank(a) - rank(b) || b.createdAt - a.createdAt;
      })
      .map((room) => this.roomSummary(room));
  }

  private markLobbyDirty(): void {
    this.lobbyDirty = true;
  }

  /** Coalesce lobby updates so a burst of joins produces one broadcast. */
  flushLobby(): void {
    if (!this.lobbyDirty) return;
    this.lobbyDirty = false;
    const rooms = this.lobbyRooms();
    for (const client of this.clients) {
      if (client.lobby) client.send({ t: 'lobby:rooms', rooms });
    }
  }

  private broadcastRoom(room: Room): void {
    const summary = this.roomSummary(room);
    for (const member of room.members) member.send({ t: 'room:state', room: summary });
    this.markLobbyDirty();
  }

  private broadcast(room: Room, message: ServerMessage, except?: Client): void {
    for (const member of room.members) {
      if (member !== except) member.send(message);
    }
  }

  private seatOf(room: Room, userId: string): Color | null {
    if (room.seats[RED] === userId) return RED;
    if (room.seats[BLACK] === userId) return BLACK;
    return null;
  }

  // ----------------------------------------------------------------- lobby --

  subscribeLobby(client: Client): void {
    client.lobby = true;
    client.send({ t: 'lobby:rooms', rooms: this.lobbyRooms() });
  }

  unsubscribeLobby(client: Client): void {
    client.lobby = false;
  }

  sendLeaderboard(client: Client, limit = 25): void {
    const rows = this.store.leaderboard(limit, this.config.leaderboardMinGames);
    client.send({
      t: 'leaderboard',
      entries: rows.map((row) => ({
        ...this.publicUser(row),
        wins: row.wins,
        losses: row.losses,
        draws: row.draws,
        aiWins: row.ai_wins,
      })),
    });
  }

  // ----------------------------------------------------------------- rooms --

  createRoom(client: Client, options: {
    name: string; passcode?: string; side: 'red' | 'black' | 'random'; rated: boolean;
    timeControl: TimeControl | null; open: boolean;
  }): void {
    if (this.rooms.size >= this.config.maxRooms) {
      this.error(client, ERROR_CODES.TOO_MANY_ROOMS, 'The server is at its room limit.');
      return;
    }
    let hosted = 0;
    for (const room of this.rooms.values()) if (room.hostId === client.userId) hosted++;
    if (hosted >= this.config.maxRoomsPerUser) {
      this.error(client, ERROR_CODES.TOO_MANY_ROOMS, 'You already have too many open rooms.');
      return;
    }

    this.leaveRoom(client, { silent: true });

    const id = newRoomId();
    const side: Color = options.side === 'random'
      ? (Math.random() < 0.5 ? RED : BLACK)
      : options.side === 'red' ? RED : BLACK;

    const room: Room = {
      id,
      name: options.name,
      passcodeHash: options.passcode
        ? hashPasscode(this.config.sessionSecret, id, options.passcode)
        : null,
      rated: options.rated,
      open: options.open,
      timeControl: options.timeControl,
      hostId: client.userId,
      seats: side === RED ? [client.userId, null] : [null, client.userId],
      members: new Set([client]),
      session: null,
      status: 'waiting',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      graceTimers: new Map(),
    };
    this.rooms.set(id, room);
    client.roomId = id;
    client.lobby = false;

    client.send({ t: 'room:joined', room: this.roomSummary(room), you: side === RED ? 'red' : 'black' });
    this.markLobbyDirty();
    this.log.info(`room ${id} created by ${client.name}`, { rated: room.rated, passcode: room.passcodeHash !== null });
  }

  joinRoom(client: Client, roomId: string, passcode: string | undefined, asSpectator: boolean): void {
    const room = this.rooms.get(roomId.toUpperCase());
    if (!room) {
      this.error(client, ERROR_CODES.ROOM_NOT_FOUND, 'No room with that code.');
      return;
    }
    if (room.passcodeHash) {
      if (!passcode || !passcodeMatches(this.config.sessionSecret, room.id, passcode, room.passcodeHash)) {
        this.error(client, ERROR_CODES.BAD_PASSCODE, 'Wrong passcode.');
        return;
      }
    }

    // Returning to a seat we already hold cancels the forfeit countdown.
    const existingSeat = this.seatOf(room, client.userId);
    if (existingSeat !== null) {
      const timer = room.graceTimers.get(client.userId);
      if (timer) {
        clearTimeout(timer);
        room.graceTimers.delete(client.userId);
        this.log.info(`${client.name} reconnected to room ${room.id}`);
      }
    }

    let seat: Color | null = existingSeat;
    if (seat === null && !asSpectator) {
      if (room.seats[RED] === null) seat = RED;
      else if (room.seats[BLACK] === null) seat = BLACK;
    }
    if (seat === null && !room.open) {
      this.error(client, ERROR_CODES.ROOM_FULL, 'That room is full and closed to spectators.');
      return;
    }

    if (client.roomId && client.roomId !== room.id) this.leaveRoom(client, { silent: true });

    if (seat !== null) room.seats[seat] = client.userId;
    room.members.add(client);
    room.lastActivity = Date.now();
    client.roomId = room.id;
    client.lobby = false;

    client.send({
      t: 'room:joined',
      room: this.roomSummary(room),
      you: seat === RED ? 'red' : seat === BLACK ? 'black' : 'spectator',
    });
    if (room.session) client.send({ t: 'game:state', state: this.gameState(room) });
    this.broadcastRoom(room);

    if (room.seats[RED] && room.seats[BLACK] && room.status === 'waiting') this.startGame(room);
  }

  leaveRoom(client: Client, options: { silent?: boolean } = {}): void {
    const room = client.roomId ? this.rooms.get(client.roomId) : null;
    client.roomId = null;
    if (!room) {
      if (!options.silent) client.send({ t: 'room:left' });
      return;
    }
    room.members.delete(client);

    const seat = this.seatOf(room, client.userId);
    if (seat !== null) {
      const timer = room.graceTimers.get(client.userId);
      if (timer) { clearTimeout(timer); room.graceTimers.delete(client.userId); }
      if (room.status === 'playing') {
        // Leaving deliberately mid-game is a forfeit, unlike a dropped connection.
        this.endGame(room, { result: seat === RED ? 'black' : 'red', reason: 'resignation' });
      }
      room.seats[seat] = null;
      if (room.status === 'playing') room.status = 'finished';
    }

    if (!options.silent) client.send({ t: 'room:left' });
    room.lastActivity = Date.now();
    this.broadcastRoom(room);
    this.reapIfEmpty(room);
    this.markLobbyDirty();
  }

  private reapIfEmpty(room: Room): void {
    if (room.members.size > 0) return;
    if (room.graceTimers.size > 0) return; // someone may still reconnect
    this.destroyRoom(room);
  }

  private destroyRoom(room: Room): void {
    if (room.session?.flagTimer) clearTimeout(room.session.flagTimer);
    if (room.session?.pendingUndo) clearTimeout(room.session.pendingUndo.timer);
    for (const timer of room.graceTimers.values()) clearTimeout(timer);
    room.graceTimers.clear();
    for (const member of room.members) {
      member.roomId = null;
      member.send({ t: 'room:left' });
    }
    room.members.clear();
    this.rooms.delete(room.id);
    this.markLobbyDirty();
  }

  emote(client: Client, emote: Emote): void {
    const room = this.roomOf(client);
    if (!room) return;
    this.broadcast(room, { t: 'room:emote', from: client.userId, emote });
  }

  pose(client: Client, head: number[], hands: number[][]): void {
    const room = this.roomOf(client);
    if (!room) return;
    // Relayed, never stored: it is 90 Hz-ish presence data, not game state.
    this.broadcast(room, { t: 'room:pose', from: client.userId, head, hands }, client);
  }

  grab(client: Client, square: number): void {
    const room = this.roomOf(client);
    if (!room) return;
    this.broadcast(room, { t: 'game:grab', from: client.userId, square }, client);
  }

  private roomOf(client: Client): Room | null {
    return client.roomId ? this.rooms.get(client.roomId) ?? null : null;
  }

  // ------------------------------------------------------------------ game --

  private startGame(room: Room): void {
    const clocks: Clocks | null = room.timeControl
      ? {
        redMs: room.timeControl.initialSeconds * 1000,
        blackMs: room.timeControl.initialSeconds * 1000,
        updatedAt: Date.now(),
        running: 'red',
      }
      : null;

    room.session = {
      id: newGameId(),
      position: Position.fromFen(START_FEN),
      startFen: START_FEN,
      moves: [],
      clockHistory: [],
      clocks,
      pendingUndo: null,
      pendingDraw: null,
      undosAccepted: 0,
      flagTimer: null,
      startedAt: Date.now(),
      lastMoveAt: Date.now(),
      over: null,
      rematchVotes: new Set(),
    };
    room.status = 'playing';
    room.lastActivity = Date.now();
    this.scheduleFlag(room);
    this.broadcastRoom(room);
    this.broadcastGame(room);
    this.log.info(`game ${room.session.id} started in room ${room.id}`);
  }

  private gameState(room: Room): GameState {
    const session = room.session!;
    return {
      fen: session.position.toFen(),
      moves: session.moves,
      turn: session.position.side === RED ? 'red' : 'black',
      inCheck: session.position.inCheck(),
      over: session.over ? { result: session.over.result, reason: session.over.reason } : null,
      clocks: session.clocks ? { ...session.clocks } : null,
    };
  }

  private broadcastGame(room: Room): void {
    const state = this.gameState(room);
    this.broadcast(room, { t: 'game:state', state });
  }

  move(client: Client, iccs: string): void {
    const room = this.roomOf(client);
    if (!room || !room.session || room.status !== 'playing') {
      this.error(client, ERROR_CODES.GAME_NOT_ACTIVE, 'No game in progress.');
      return;
    }
    const session = room.session;
    const seat = this.seatOf(room, client.userId);
    if (seat === null) {
      this.error(client, ERROR_CODES.NOT_IN_ROOM, 'Spectators cannot move.');
      return;
    }
    if (seat !== session.position.side) {
      this.error(client, ERROR_CODES.NOT_YOUR_TURN, 'It is not your turn.');
      return;
    }

    // Validated against the server's own position — the client's copy is advice.
    const move = iccsToMove(session.position, iccs);
    if (move === 0) {
      this.error(client, ERROR_CODES.ILLEGAL_MOVE, `Illegal move: ${iccs}`);
      // Resync the offender so a desynced board self-heals.
      client.send({ t: 'game:state', state: this.gameState(room) });
      return;
    }

    const now = Date.now();
    const text = describeMove(session.position, move);
    if (session.clocks) {
      session.clockHistory.push({ redMs: session.clocks.redMs, blackMs: session.clocks.blackMs });
    } else {
      session.clockHistory.push({ redMs: 0, blackMs: 0 });
    }

    session.position.applyMove(move);
    session.moves.push({ ...text, ms: now - session.lastMoveAt });
    session.lastMoveAt = now;
    room.lastActivity = now;

    // A move supersedes any outstanding offer.
    this.cancelPendingUndo(session);
    session.pendingDraw = null;

    this.tickClock(room, seat);

    const status = session.position.status();
    if (status) {
      this.endGame(room, status);
      return;
    }
    this.scheduleFlag(room);
    this.broadcastGame(room);
  }

  private tickClock(room: Room, mover: Color): void {
    const session = room.session!;
    if (!session.clocks || !room.timeControl) return;
    const now = Date.now();
    const elapsed = now - session.clocks.updatedAt;
    if (mover === RED) {
      session.clocks.redMs = Math.max(0, session.clocks.redMs - elapsed)
        + room.timeControl.incrementSeconds * 1000;
      session.clocks.running = 'black';
    } else {
      session.clocks.blackMs = Math.max(0, session.clocks.blackMs - elapsed)
        + room.timeControl.incrementSeconds * 1000;
      session.clocks.running = 'red';
    }
    session.clocks.updatedAt = now;
  }

  private scheduleFlag(room: Room): void {
    const session = room.session;
    if (!session) return;
    if (session.flagTimer) { clearTimeout(session.flagTimer); session.flagTimer = null; }
    if (!session.clocks || !session.clocks.running) return;
    const remaining = session.clocks.running === 'red' ? session.clocks.redMs : session.clocks.blackMs;
    session.flagTimer = setTimeout(() => {
      if (room.status !== 'playing' || !room.session) return;
      const loser = room.session.clocks?.running;
      if (!loser) return;
      if (loser === 'red') room.session.clocks!.redMs = 0;
      else room.session.clocks!.blackMs = 0;
      this.endGame(room, { result: loser === 'red' ? 'black' : 'red', reason: 'timeout' });
    }, Math.max(0, remaining) + 50);
  }

  resign(client: Client): void {
    const room = this.roomOf(client);
    if (!room || room.status !== 'playing') {
      this.error(client, ERROR_CODES.GAME_NOT_ACTIVE, 'No game in progress.');
      return;
    }
    const seat = this.seatOf(room, client.userId);
    if (seat === null) return;
    this.endGame(room, { result: seat === RED ? 'black' : 'red', reason: 'resignation' });
  }

  // ------------------------------------------------------------- 悔棋 undo --

  requestUndo(client: Client): void {
    const room = this.roomOf(client);
    if (!room?.session || room.status !== 'playing') {
      this.error(client, ERROR_CODES.GAME_NOT_ACTIVE, 'No game in progress.');
      return;
    }
    const session = room.session;
    const seat = this.seatOf(room, client.userId);
    if (seat === null) {
      this.error(client, ERROR_CODES.NOT_IN_ROOM, 'Only players can ask to take back a move.');
      return;
    }
    if (session.pendingUndo) {
      this.error(client, ERROR_CODES.ALREADY_PENDING, 'There is already a pending request.');
      return;
    }
    if (session.position.plies === 0) {
      this.error(client, ERROR_CODES.NOTHING_TO_UNDO, 'No moves to take back yet.');
      return;
    }

    // Take back far enough that it is the requester's turn again: two plies if
    // the opponent has already replied, one if they have not.
    const plies = session.position.side === seat
      ? Math.min(2, session.position.plies)
      : 1;

    const opponentId = room.seats[seat === RED ? BLACK : RED];
    if (!opponentId) {
      this.error(client, ERROR_CODES.NO_PENDING_REQUEST, 'No opponent to ask.');
      return;
    }

    const timer = setTimeout(() => {
      if (room.session?.pendingUndo?.by !== seat) return;
      room.session.pendingUndo = null;
      this.broadcast(room, { t: 'game:undo-result', accepted: false, by: opponentId });
    }, this.config.undoResponseTimeoutMs);

    session.pendingUndo = { by: seat, plies, timer };
    this.broadcast(
      room,
      { t: 'game:undo-requested', by: client.userId, byName: client.name },
      client,
    );
  }

  respondUndo(client: Client, accept: boolean): void {
    const room = this.roomOf(client);
    const session = room?.session;
    const pending = session?.pendingUndo;
    if (!room || !session || !pending) {
      this.error(client, ERROR_CODES.NO_PENDING_REQUEST, 'Nothing to respond to.');
      return;
    }
    const seat = this.seatOf(room, client.userId);
    if (seat === null || seat === pending.by) {
      this.error(client, ERROR_CODES.UNAUTHORIZED, 'Only the opponent can answer that.');
      return;
    }

    const { plies } = pending;
    this.cancelPendingUndo(session);

    if (!accept) {
      this.broadcast(room, { t: 'game:undo-result', accepted: false, by: client.userId });
      return;
    }

    for (let i = 0; i < plies; i++) {
      if (session.position.plies === 0) break;
      session.position.undo();
      session.moves.pop();
      const snapshot = session.clockHistory.pop();
      if (snapshot && session.clocks) {
        session.clocks.redMs = snapshot.redMs;
        session.clocks.blackMs = snapshot.blackMs;
      }
    }
    if (session.clocks) {
      session.clocks.updatedAt = Date.now();
      session.clocks.running = session.position.side === RED ? 'red' : 'black';
    }
    session.undosAccepted++;
    session.lastMoveAt = Date.now();
    this.scheduleFlag(room);
    this.broadcast(room, { t: 'game:undo-result', accepted: true, by: client.userId });
    this.broadcastGame(room);
  }

  private cancelPendingUndo(session: Session): void {
    if (!session.pendingUndo) return;
    clearTimeout(session.pendingUndo.timer);
    session.pendingUndo = null;
  }

  offerDraw(client: Client): void {
    const room = this.roomOf(client);
    if (!room?.session || room.status !== 'playing') return;
    const seat = this.seatOf(room, client.userId);
    if (seat === null) return;
    if (room.session.pendingDraw) {
      this.error(client, ERROR_CODES.ALREADY_PENDING, 'A draw offer is already pending.');
      return;
    }
    room.session.pendingDraw = { by: seat };
    this.broadcast(room, { t: 'game:draw-offered', by: client.userId, byName: client.name }, client);
  }

  respondDraw(client: Client, accept: boolean): void {
    const room = this.roomOf(client);
    if (!room?.session?.pendingDraw) {
      this.error(client, ERROR_CODES.NO_PENDING_REQUEST, 'Nothing to respond to.');
      return;
    }
    const seat = this.seatOf(room, client.userId);
    if (seat === null || seat === room.session.pendingDraw.by) {
      this.error(client, ERROR_CODES.UNAUTHORIZED, 'Only the opponent can answer that.');
      return;
    }
    room.session.pendingDraw = null;
    this.broadcast(room, { t: 'game:draw-result', accepted: accept, by: client.userId });
    if (accept) this.endGame(room, { result: 'draw', reason: 'agreement' });
  }

  rematch(client: Client): void {
    const room = this.roomOf(client);
    if (!room?.session || room.status !== 'finished') return;
    const seat = this.seatOf(room, client.userId);
    if (seat === null) return;
    room.session.rematchVotes.add(client.userId);

    const red = room.seats[RED];
    const black = room.seats[BLACK];
    if (!red || !black) return;
    if (!room.session.rematchVotes.has(red) || !room.session.rematchVotes.has(black)) {
      this.broadcastRoom(room);
      return;
    }
    // Swap colours so nobody keeps the first-move advantage.
    room.seats[RED] = black;
    room.seats[BLACK] = red;
    room.status = 'waiting';
    this.startGame(room);
  }

  // -------------------------------------------------------------- game end --

  private endGame(room: Room, over: GameOver): void {
    const session = room.session;
    if (!session || room.status === 'finished') return;

    if (session.flagTimer) { clearTimeout(session.flagTimer); session.flagTimer = null; }
    this.cancelPendingUndo(session);
    session.pendingDraw = null;
    session.over = over;
    if (session.clocks) session.clocks.running = null;
    room.status = 'finished';
    room.lastActivity = Date.now();
    session.rematchVotes.clear();

    const redId = room.seats[RED];
    const blackId = room.seats[BLACK];
    const redUser = redId ? this.store.userById(redId) : null;
    const blackUser = blackId ? this.store.userById(blackId) : null;

    const undoBlocked = this.config.undoMakesUnrated && session.undosAccepted > 0;
    const rated = room.rated
      && !undoBlocked
      && redUser !== null && blackUser !== null
      && redUser.guest === 0 && blackUser.guest === 0
      && redUser.id !== blackUser.id
      // A game decided in the first few moves says nothing about strength.
      && session.moves.length >= 8;

    const changes: RatingChange[] = [];
    if (rated && redUser && blackUser) {
      const redBefore = this.store.ratingOf(redUser);
      const blackBefore = this.store.ratingOf(blackUser);
      const redScore: Score = over.result === 'draw' ? 0.5 : over.result === 'red' ? 1 : 0;
      const blackScore: Score = over.result === 'draw' ? 0.5 : over.result === 'black' ? 1 : 0;
      // Both updates read the pre-game ratings, so the order does not matter.
      const redAfter = updateRating(redBefore, blackBefore, redScore);
      const blackAfter = updateRating(blackBefore, redBefore, blackScore);
      this.store.applyRating(redUser.id, redAfter);
      this.store.applyRating(blackUser.id, blackAfter);
      changes.push(
        { userId: redUser.id, before: Math.round(redBefore.rating), after: Math.round(redAfter.rating) },
        { userId: blackUser.id, before: Math.round(blackBefore.rating), after: Math.round(blackAfter.rating) },
      );
    }

    if (redUser && blackUser) {
      const redOutcome = over.result === 'draw' ? 'draw' : over.result === 'red' ? 'win' : 'loss';
      const blackOutcome = over.result === 'draw' ? 'draw' : over.result === 'black' ? 'win' : 'loss';
      this.store.recordOutcome(redUser.id, 'pvp', redOutcome);
      this.store.recordOutcome(blackUser.id, 'pvp', blackOutcome);
    }

    this.store.recordGame({
      id: session.id,
      mode: 'pvp',
      red_id: redId,
      black_id: blackId,
      ai_level: null,
      result: over.result,
      reason: over.reason,
      rated: rated ? 1 : 0,
      start_fen: session.startFen,
      moves: session.moves.map((m) => m.iccs).join(' '),
      red_rating_before: changes[0]?.before ?? null,
      red_rating_after: changes[0]?.after ?? null,
      black_rating_before: changes[1]?.before ?? null,
      black_rating_after: changes[1]?.after ?? null,
    });

    this.broadcastGame(room);
    this.broadcast(room, {
      t: 'game:over', result: over.result, reason: over.reason, ratings: changes,
    });
    this.broadcastRoom(room);
    this.log.info(`game ${session.id} ended: ${over.result} by ${over.reason}`, { rated });
  }

  // --------------------------------------------------- AI games (reported) --

  /**
   * Rate a game played against the on-device AI.
   *
   * The search runs on the headset, so the server cannot witness the game — but
   * it can refuse to take the client's word for the *result*: the whole move
   * list is replayed through the rules engine and the claimed winner must match
   * what the final position actually says. That blocks fabricated wins from a
   * hand-edited client without a server-side engine. It cannot prove the AI
   * really played at the stated level, which is why `RATE_AI_GAMES=false` is
   * offered for hosts who want the ladder to reflect PvP only.
   */
  reportAiGame(client: Client, report: {
    level: number; playerColor: 'red' | 'black'; moves: string[];
    result: 'red' | 'black' | 'draw'; undos: number;
  }): void {
    const user = this.store.userById(client.userId);
    if (!user) return;

    const reject = (reason: string) => {
      client.send({ t: 'ai:rated', rating: null, reason });
    };

    if (!this.config.rateAiGames) return reject('ai-games-unrated');
    if (user.guest === 1) return reject('guest');
    if (report.undos > 0) return reject('undo-used');
    if (report.moves.length < 8) return reject('too-short');

    const now = Date.now();
    if (now - client.lastAiReportAt < this.config.aiReportCooldownMs) return reject('too-soon');
    client.lastAiReportAt = now;

    // Replay the whole game. Any illegal move means the report is fabricated.
    const position = Position.fromFen(START_FEN);
    for (const iccs of report.moves) {
      const move = iccsToMove(position, iccs);
      if (move === 0) {
        this.log.warn(`rejected AI report from ${client.name}: illegal move ${iccs}`);
        return reject('invalid-game');
      }
      position.applyMove(move);
    }

    const finalStatus = position.status();
    // A resignation has no terminal position, so accept a claimed loss for the
    // human without a matching status — but never a claimed win.
    const claimedWin = report.result === report.playerColor;
    if (!finalStatus) {
      if (claimedWin || report.result === 'draw') return reject('unfinished');
    } else if (finalStatus.result !== report.result) {
      this.log.warn(`rejected AI report from ${client.name}: result mismatch`);
      return reject('result-mismatch');
    }

    const playerColor: Color = report.playerColor === 'red' ? RED : BLACK;
    const score: Score = report.result === 'draw'
      ? 0.5
      : (report.result === 'red' ? RED : BLACK) === playerColor ? 1 : 0;

    const before = this.store.ratingOf(user);
    const after = updateRating(before, aiRating(report.level), score);
    this.store.applyRating(user.id, after);
    this.store.recordOutcome(user.id, 'ai', score === 1 ? 'win' : score === 0 ? 'loss' : 'draw');
    this.store.recordGame({
      id: newGameId(),
      mode: 'ai',
      red_id: playerColor === RED ? user.id : null,
      black_id: playerColor === BLACK ? user.id : null,
      ai_level: report.level,
      result: report.result,
      reason: finalStatus?.reason ?? 'resignation',
      rated: 1,
      start_fen: START_FEN,
      moves: report.moves.join(' '),
      red_rating_before: playerColor === RED ? Math.round(before.rating) : null,
      red_rating_after: playerColor === RED ? Math.round(after.rating) : null,
      black_rating_before: playerColor === BLACK ? Math.round(before.rating) : null,
      black_rating_after: playerColor === BLACK ? Math.round(after.rating) : null,
    });

    client.send({
      t: 'ai:rated',
      rating: { userId: user.id, before: Math.round(before.rating), after: Math.round(after.rating) },
    });
    this.log.info(`AI game rated for ${client.name}: level ${report.level}, ${report.result}`);
  }
}
