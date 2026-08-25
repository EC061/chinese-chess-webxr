# Deploying on 1Panel

This is the compose file behind the live deployment at
<https://chess.edwardcheng.net>, kept here so the setup is reproducible rather
than living only in the panel's database.

It targets **容器 → 编排 → 创建编排** (Container → Compose). It is deliberately
*not* the App Store local-app format: that one references `${CONTAINER_NAME}`,
`${CPUS}`, `${MEMORY_LIMIT}`, `${HOST_IP}` and `${PANEL_APP_PORT_HTTP}`, which
only exist when 1Panel generates a `.env` from an app's `data.yml` form. Paste
those into the Compose page and `container_name` resolves to an empty string,
which fails schema validation before anything starts.

## Setup

```sh
cd /opt/1panel/docker/compose/chinese-chess-webxr   # or wherever the panel put it
cp .env.example .env
sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env

# The container runs as uid 1000. A bind mount arrives root-owned, and SQLite
# then cannot create its -wal sidecar, so the server exits on boot.
mkdir -p ./data && chown -R 1000:1000 ./data

docker compose config -q && docker compose up -d
docker logs --tail 20 xiangqi-app
```

A healthy start logs exactly three lines:

```
中国象棋 WebXR server listening on http://0.0.0.0:8080
database: /data/xiangqi.db  static: /app/public
cross-origin isolation on (multi-threaded AI available)
```

## Pointing the proxy at it

The container publishes plain HTTP on 8080 and expects TLS to be terminated in
front of it. Pick whichever matches your topology:

- **OpenResty on this host, on `1panel-network`** — target
  `http://xiangqi-app:8080` and delete the `ports:` block entirely. Nothing is
  exposed on the host at all. This is the best option.
- **Proxy on this host, host networking** — keep
  `ports: "127.0.0.1:8080:8080"` and target `http://127.0.0.1:8080`.
- **Proxy on a different machine** — change the binding to `"0.0.0.0:8080:8080"`
  and **firewall 8080 to the proxy's address only**. That rule is not optional:
  `TRUST_PROXY=true` means the app believes `X-Forwarded-For`, so anyone who can
  reach 8080 directly can forge it and walk past every per-IP connection and
  auth rate limit. A VPS "private" network is not private enough on its own.

Two things the proxy must get right, both of which fail silently:

1. **Serve HTTPS.** A headset refuses to start an immersive session on an
   insecure origin, so the experience cannot run at all over plain HTTP.
2. **Pass `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
   through untouched.** Strip them and the browser withholds
   `SharedArrayBuffer`, dropping the AI from a multi-threaded search sharing one
   transposition table to a single worker — roughly two plies weaker, with
   nothing in any log to say so.

Verify both from outside:

```sh
curl -sI https://your-domain/ | grep -i cross-origin
```

You want all three of `cross-origin-opener-policy: same-origin`,
`cross-origin-embedder-policy: require-corp` and
`cross-origin-resource-policy: same-origin`.

## Behind Cloudflare

A CDN will happily rewrite `Strict-Transport-Security`. With HSTS switched off in
the dashboard, Cloudflare replaces the app's `max-age=31536000` with
`max-age=0`, which tells browsers to *discard* any pin they hold — so setting
`PUBLIC_ORIGIN` has no visible effect at the edge. If you want HSTS, enable it
under **SSL/TLS → Edge Certificates**, and be aware that `includeSubDomains`
breaks any sibling subdomain not on HTTPS and cannot be withdrawn quickly.

Leave `PUBLIC_ORIGIN` set regardless; it still applies if anything reaches the
origin directly.

WebSocket upgrades must reach the container for multiplayer to work. A quick
check — the app answering `401` to an unauthenticated upgrade is the *correct*
result, and proves the upgrade is proxied end to end:

```sh
curl -sI --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://your-domain/ws
```

A 502 means an intermediary swallowed the upgrade; HTML means it fell through to
the SPA route.

## Pulling the image

`ghcr.io/ec061/chinese-chess-webxr:latest` is public, so no login is needed.
Note that GHCR package visibility is a **separate setting from the
repository's** — making the repo public does not carry it over, and a private
package fails the pull with a bare `unauthorized`. If you fork this, either flip
the package to public in its settings, or add `ghcr.io` credentials under
**容器 → 仓库**.

## Backups

Everything is SQLite in WAL mode under `./data`. The server runs a truncating
checkpoint on shutdown, so a stopped container's directory is a consistent
snapshot:

```sh
docker compose stop
tar czf xiangqi-$(date +%F).tar.gz ./data
docker compose start
```
