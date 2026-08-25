# chinese-chess-webxr

中国象棋 (Xiangqi) as a seated WebXR experience, built for **Meta Quest 3 / 3S**.
Sit down at a virtual table and play the on-device AI, or another person across
a passcode-protected room. Fully playable on a screen too.

```
 ┌─────────────┬──────────────────────────────────────────────────────────────┐
 │ Play the AI │ 8 strength levels · 悔棋 any time · runs entirely on-device   │
 │ Play a soul │ Room list, passcodes, Glicko-2 ratings, spectators, clocks   │
 │ Learn       │ Interactive tutorial for all seven pieces, 中文 and English   │
 └─────────────┴──────────────────────────────────────────────────────────────┘
```

---

## What's in the box

**Human vs AI.** The search runs in Web Workers on the headset, so it costs the
server nothing and works with the network down. Eight levels, dialled with four
independent knobs — search depth, time budget, root-score noise, and an outright
blunder chance — so level 1 plays like a beginner who hangs pieces rather than
like a strong engine playing badly. 悔棋 (take back) is instant and unlimited
here; there is nobody to wrong.

**Human vs human.** Browse a room list, or open a room behind a 4–8 digit
passcode you can read aloud. The server owns the position and re-validates every
move through the same rules engine the client runs, so a modified client cannot
cheat. 悔棋 is a *request* the opponent must accept, and by default accepting one
makes the game unrated.

**No sign-in to get started.** A headset that has never been here gets a named
guest account and lands on the board — nothing typed, nothing asked. When the
player wants a real account, they read an eight-character code off a panel and
type it on their phone; the headset picks up the session by itself. See *Signing
in without a keyboard*.

**Ratings.** Glicko-2, fed by both human games and AI games, with rating
deviation so a new player converges quickly and a veteran's rating stays stable.
Guests are never rated.

**Tutorial.** One lesson per piece with worked examples and a puzzle. Every
highlighted dot comes from `Position.legalTargets` — the real move generator —
so the tutorial cannot drift out of sync with how the game actually plays. It
covers the things that catch out chess players: 马腿, 象眼, the river, why the
cannon needs a screen, and 飞将.

**Bilingual throughout.** Chinese and English, switchable at any moment.
Hovering a piece names it in the chosen language; the move list renders as
`炮二平五` or `Cannon h2-e2`.

---

## Quick start

Needs **Node 24 or newer** — the server stores games through the built-in
`node:sqlite`, so there is no native module to compile and nothing to install
beyond the lockfile.

```sh
npm install
npm run dev          # server on :8080, client on :5173
```

Open <http://localhost:5173>.

### On a Quest 3

WebXR requires a secure origin, so `http://<your-laptop-ip>:5173` will not start
an immersive session. Two options:

```sh
# 1. USB, no certificates needed — localhost counts as secure
adb reverse tcp:5173 tcp:5173
adb reverse tcp:8080 tcp:8080
# then open http://localhost:5173 in the headset browser

# 2. Or deploy for real (below) and open https://your-domain
```

### Useful commands

| Command | What it does |
| --- | --- |
| `npm test` | 137 tests: rules, perft, tutorial, ratings, engine, server integration |
| `npm run typecheck` | Typechecks all four packages |
| `npm run build` | Builds shared, ai, client, server |
| `npm run bundle` | Build + bundle the server to a single `server.mjs` |
| `npx tsx tools/bench.mts` | Engine benchmark: nodes/sec and branching factor |
| `npx tsx tools/checkline.mts h2e2 h7e7 …` | Replay a move list, print notation, validate |

---

## Deploying

```sh
cp .env.example .env
#   SESSION_SECRET   openssl rand -hex 32
docker compose up -d
```

That starts one container listening on `${APP_PORT:-8080}`. **TLS is not handled
here** — put your own reverse proxy in front of it.

Images are built by GitHub Actions and published to GHCR for `linux/amd64` and
`linux/arm64`:

```sh
IMAGE=ghcr.io/ec061/chinese-chess-webxr:latest docker compose up -d
```

If the proxy runs on the same host, set `BIND_ADDR=127.0.0.1` so the plain HTTP
port is not reachable from the network.

### What the reverse proxy has to get right

Two requirements, both of which fail *silently* — the app will look like it
works and quietly be worse:

1. **Serve it over HTTPS.** WebXR requires a secure origin. Over plain HTTP the
   headset will load the page and refuse to start an immersive session, so
   there is no VR at all.
2. **Pass `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
   through untouched.** The app sends both. Strip them and the page loses
   cross-origin isolation, the browser stops handing out `SharedArrayBuffer`,
   and the AI silently drops from a multi-threaded search over a shared
   transposition table to a single worker — roughly two plies weaker.

Also make sure WebSocket upgrades are proxied (`/ws`), and give them a long
idle timeout: a seated game can sit still for minutes while someone thinks.

Most proxies forward response headers by default, so requirement 2 usually needs
nothing — just don't add a header allowlist.

<details>
<summary><b>nginx</b></summary>

```nginx
server {
    listen 443 ssl http2;
    server_name xiangqi.example.com;

    ssl_certificate     /etc/letsencrypt/live/xiangqi.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/xiangqi.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket upgrade for live play.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        # A game can idle for a long time between moves.
        proxy_read_timeout  600s;
        proxy_send_timeout  600s;

        # Do not add proxy_hide_header for COOP/COEP — the app needs them
        # to reach the browser intact.
    }
}
```
</details>

<details>
<summary><b>Traefik</b> (labels on the <code>app</code> service)</summary>

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.xiangqi.rule=Host(`xiangqi.example.com`)
  - traefik.http.routers.xiangqi.entrypoints=websecure
  - traefik.http.routers.xiangqi.tls.certresolver=letsencrypt
  - traefik.http.services.xiangqi.loadbalancer.server.port=8080
```

Traefik handles WebSocket upgrades and passes response headers through with no
extra configuration.
</details>

<details>
<summary><b>Caddy</b></summary>

```caddyfile
xiangqi.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080 {
		transport http {
			read_timeout 600s
			write_timeout 600s
		}
	}
}
```
</details>

### Environment

Every variable is documented in [`.env.example`](.env.example). The ones that
matter most:

| Variable | Why you might change it |
| --- | --- |
| `SESSION_SECRET` | **Required.** Signs session cookies, pairing codes, and room passcodes. |
| `APP_PORT` / `BIND_ADDR` | Where the proxy finds the app. `127.0.0.1` if same host. |
| `HOST` | Interface the server listens on inside the container. Leave `0.0.0.0`; the published port has nothing to reach otherwise. |
| `TRUST_PROXY` | Keep `true` behind a proxy that sets `X-Forwarded-For`. Set `false` if the port is reachable directly, or per-IP limits can be spoofed. |
| `CROSS_ORIGIN_ISOLATION` | Keep `true`. See above. |
| `RATE_AI_GAMES` | Set `false` for a ladder of only server-witnessed games — see *Trust*, below. |
| `PUBLIC_ORIGIN` | Decides whether the app sends HSTS, and the origin it accepts requests from. Leave blank if your proxy already sends HSTS. |
| `ALLOW_GUESTS` | Keep `true` unless you want a closed server — it is the front door, not a fallback. See below. |
| `SESSION_PERSIST_DAYS` | How long "stay signed in" lasts. 400 is the default *and* the ceiling a browser will honour. |
| `SECURE_COOKIES` | Leave unset; it follows `PUBLIC_ORIGIN`. Only set it for a plain-HTTP dev server. |

### Backups

Everything lives in the `xiangqi-data` volume as SQLite in WAL mode.

Cold, and simplest — the server runs a truncating checkpoint on shutdown, so a
stopped container's volume is a consistent snapshot:

```sh
docker compose stop app
docker run --rm -v xiangqi-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/xiangqi-$(date +%F).tar.gz -C /data .
docker compose start app
```

Hot, no downtime. The runtime image is `node:alpine` and has no `sqlite3`
binary, so borrow one from a throwaway container on the same volume —
`.backup` takes its own locks and is safe against the running server:

```sh
docker run --rm -v xiangqi-data:/data -v "$PWD:/backup" alpine \
  sh -c 'apk add -q sqlite && sqlite3 /data/xiangqi.db ".backup /backup/xiangqi.db"'
```

### On 1Panel

[`deploy/1panel/`](deploy/1panel/) holds the compose file behind the live
deployment, with notes on the things that fail quietly there: the bind mount's
ownership against the container's uid, GHCR package visibility being separate
from the repository's, and a CDN rewriting `Strict-Transport-Security`.

---

## How it is built

```
packages/
  shared/   Rules engine, notation, tutorial content, Glicko-2, wire protocol
  ai/       Evaluation, alpha-beta search, transposition table, worker plumbing
  server/   HTTP + WebSocket, SQLite, rooms, ratings
  client/   React Three Fiber scene, in-headset panels, flat interface
```

`shared` is the important boundary: **the server and every client run the exact
same rules engine.** A move accepted by one is accepted by all, the tutorial
cannot show an illegal highlight, and the AI cannot search a position the server
would reject.

### The rules engine

Move generation is verified against the published perft node counts for
Xiangqi's opening position:

| Depth | Nodes |
| --- | --- |
| 1 | 44 |
| 2 | 1,920 |
| 3 | 79,666 |
| 4 | 3,290,240 |

Matching all four is a strong signal that 马腿 blocking, 象眼 blocking, the river
constraints, cannon screens, and 飞将 are all exactly right, since an error in
any of them shifts the counts.

Three Xiangqi rules that differ from western chess are implemented deliberately,
because getting them wrong changes real games:

- **Having no legal move is a loss (困毙), not a draw.** Stalemate scores as mate
  in the search.
- **飞将 / flying general.** The two generals may never face each other down an
  open file. This is folded into `isAttacked` by treating an enemy general with a
  clear file as a chariot on that file, which makes it fall out of ordinary
  legality checking rather than being a special case bolted on afterwards.
- **长将 / perpetual check.** Threefold repetition is a draw *unless* exactly one
  side gave check on every one of its moves in the cycle, in which case that side
  loses.

Simplified for sanity, and documented rather than hidden: 60 moves without a
capture is a draw, and the fuller 长捉 (perpetual chase) rules are not
implemented — repetition that is not perpetual check draws.

### The AI

Alpha-beta with iterative deepening, a transposition table, killer and history
heuristics, MVV-LVA ordering, late move reductions, null-move pruning, and a
capture-only quiescence search with delta pruning.

Measured on an M-series laptop, single-threaded:

```
L5 Strong        depth 6   82k nodes    0.4s   252k nps
L6 Expert        depth 8  361k nodes    1.4s   263k nps
L7 Master        depth 9    1M nodes    3.8s   277k nps
L8 Grandmaster   depth 9  2.2M nodes    8.0s   281k nps
```

The effective branching factor between iterations is about **6.2**, against a
theoretical best of ~6.3 for Xiangqi's ~40-move branching — move ordering is
essentially optimal, and further gains would have to come from a better
evaluation, not a better search. Expect roughly a third of that node rate per
core on a Quest 3, recovered by running three workers.

**Multi-threading.** When the page is cross-origin isolated, the transposition
table is allocated in a `SharedArrayBuffer` and several workers search against it
(Lazy SMP): helper threads do not report moves, they deepen the shared table so
the primary thread reaches further in the same wall clock. Entries are written
without locks and verified by an XOR checksum, and any move read from the table
is re-validated for legality before use — the standard lockless-hashing trade,
and the reason a torn entry cannot corrupt a game.

Levels 1–4 are not "the engine, weakened". They add uniform noise to *root move
scores*, so the AI picks a move that is genuinely second- or third-best rather
than a nonsensical one, plus an explicit blunder chance for the lowest levels.
From level 2 up it will still refuse a move that hands you mate in one.

**Want a stronger opponent?** `packages/ai/src/engine.ts` defines an `Engine`
interface with two implementations: the built-in searcher and `UciEngine`, an
adapter for any UCI engine compiled to WebAssembly (Pikafish, Fairy-Stockfish).
Drop a build under `public/engines/` and set `VITE_UCI_ENGINE_URL`. No game code
changes. This repository vendors no engine binaries.

### The client

React Three Fiber with `@react-three/xr` v6. Interaction goes through
`@pmndrs/pointer-events`, so controller rays, hand pinches, and a desktop mouse
all dispatch the same `onClick` — every widget is written once and works in both
places.

Both players share one world: Black is not shown a mirrored board, Black is
seated on the far side and turned around. That is what makes the avatars, the
pieces, and a pointed finger line up between headsets.

Board and piece art is drawn with the 2D canvas API at load time rather than
shipped as images. The decisive reason is that the piece faces are 汉字, and the
alternative is bundling a CJK font — several megabytes even subset — or accepting
fallback boxes. Canvas uses the system font, which every headset browser has, and
renders each glyph at texture resolution.

Each side's pieces face their owner, as on a real board: you read yours upright
and your opponent's upside down. It doubles as an instant cue for whose piece is
whose.

Production bundle, gzipped: ~176 kB three.js, ~146 kB app, ~45 kB React.

---

## Signing in without a keyboard

A VR keyboard is a laser pointer and a floating slab of letters. Pecking out a
password on one is bad enough that it decides the design of everything below —
and it gets worse, because the system keyboard only exists in the 2D browser, so
inside an immersive session there is no text entry at all.

Three consequences.

**Nobody signs in to start playing.** First load creates a guest account with a
generated name — 「疾风马 4271」, `Bold General 2804` — and goes straight to the
board. It is a real row in `users`, not a placeholder, so the games it plays are
recorded against it and stay on its record when the player claims it later.
Claiming happens *in place*: same id, same history, a name and a password added.
There is no second account and nothing to merge.

**The one step that needs a keyboard happens on a phone.** The headset shows a
code, the player opens `/link` on their phone, types eight characters, and signs
in or sets a password there. The headset polls and picks up the session. This is
the device authorization grant (RFC 8628) — the pattern a television uses — and
it works *inside* an immersive session, which is the point: it never asks anyone
to take the headset off.

It is deliberately not a QR code. A phone camera cannot photograph a display
that is strapped to the player's face. What does work is passthrough: with the
room visible, someone reads the panel and uses their actual phone without
leaving the session.

The code is eight characters from an alphabet with no `I`, `O`, `0` or `1`,
grouped as `BKQP-7RTM`, and typed back in any case with or without the dash —
every character has to survive being read at arm's length inside a headset. It
is also *not* the credential. The headset keeps a separate 256-bit device code
and polling requires it, so reading the panel over someone's shoulder gets you
nothing.

**The session has to survive months of not being used.** It lives in an
`HttpOnly; Secure; SameSite=Lax` cookie, which buys three things at once: script
on the page cannot read a credential that sits on a device for a year, the
WebSocket handshake authenticates from the same cookie so the session no longer
travels in a query string where proxies log it, and it is unaffected by whatever
clears `localStorage`.

Two mechanisms keep it alive. Chromium — and therefore Meta's browser — clamps
any cookie to **400 days from when it was set**, so the server re-stamps it
whenever a player opens the app after a day away, sliding the window forward
indefinitely. And because a headset can sit in a drawer for three weeks and look
exactly like a site worth evicting, the client calls
`navigator.storage.persist()` to exempt the origin from that sweep.

Persistence is a choice, not a default that cannot be escaped. **Stay signed in
on this device** is on by default — the alternative on a headset is retyping a
password with a laser pointer — but turning it off downgrades the cookie to a
session cookie that dies with the browser, which is the right answer for a
headset the whole house wears. The switch is in Settings and takes effect
immediately.

What did *not* get built, and why: passkeys, which are the obvious answer and
are excellent on Vision Pro, but platform-authenticator support on Quest is
inconsistent enough that shipping them as the only path would strand players.
The pairing flow above is the portable floor; passkeys can layer on top of it
later behind a capability check.

---

## Trust, and what the server can actually prove

Human-versus-human games are fully authoritative. The server holds the position,
validates every move, and a client that sends an illegal one gets an error and a
resync.

AI games are different, and worth being straight about: the search runs in the
player's headset, so the server never witnesses those games. What it *can* do —
and does — is replay the entire reported move list through the rules engine and
reject any result the final position does not support, which stops fabricated
wins from a hand-edited client. What it cannot do is prove the AI really played
at the level claimed. Reports are also rate-limited, and any game with a 悔棋 in
it is rejected.

If you want a ladder that reflects only games the server can vouch for, set
`RATE_AI_GAMES=false`. Human-versus-human ratings are unaffected.

---

## Testing

```
packages/shared/test/rules.test.ts        move generation, perft, notation, game end
packages/shared/test/tutorial.test.ts     every demo and puzzle, run through the engine
packages/shared/test/rating.test.ts       Glicko-2 convergence
packages/ai/test/search.test.ts           evaluation, tactics, levels, self-play
packages/server/test/integration.test.ts  real sockets, real SQLite, real games
```

The server tests cover the things unit tests cannot: that an illegal move is
rejected and the client resynced, that a spectator cannot move, that 悔棋 needs
consent and a declined request leaves the board alone, that passcodes are
enforced, and that a fabricated AI result is refused.

They also cover the session and pairing rules, which are easy to get subtly
wrong: that the session never appears in a response body or a query string, that
a cookie old enough for its expiry to have drifted comes back re-stamped for a
full window while a non-persistent one does not, that claiming a guest keeps its
id, that a pairing code is useless to a poller without the matching device code,
and that neither a POST nor a socket handshake claiming a foreign origin is
accepted.

The tutorial tests are worth a special mention — they assert that every demo
board parses, that the focused piece has moves to show, that every marked
obstacle is really occupied, and that every puzzle solution is a legal move that
achieves what the text claims. Tutorial content cannot rot.

---

## License

MIT.
