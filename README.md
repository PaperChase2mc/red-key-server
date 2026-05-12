# Red Key — Game Server

Authoritative multiplayer game server for Red Key. The simulation (ball
physics, clashes, goals, matchmaking) all runs here. The browser clients are
pure renderers + input senders, so both players see identical pixels.

The server **also serves `red-key.html`** over HTTP on the same port, so
players just visit the server's URL in a browser — no config, no URL pasting,
nothing for them to set up.

## Run locally

You need Node.js 18+.

```bash
cd red-key-server
npm install
npm start
```

You should see:

```
Serving HTML from .../red-key-server/red-key.html
Red Key server ready: http://localhost:3000/
```

Open <http://localhost:3000/> in your browser — that's the whole game. Open it
in two browser windows, register two accounts, click **Multiplayer → Start**
on each. They pair instantly.

To play across the LAN, find your machine's local IP (e.g. `192.168.1.42`)
and have others visit `http://192.168.1.42:3000/`. Zero per-device setup.

> Note: keep `red-key.html` next to `server.mjs` in this folder so the
> server can serve it. The bundled file in this folder is kept in sync as
> the source-of-truth. If you make changes in the parent `red-key.html`,
> copy it over the one inside `red-key-server/` before redeploying.

## Deploy publicly so anyone can play

All four options below give you a single URL like `https://red-key-x.onrender.com`.
Players just visit that URL — the page, the WebSocket, and the simulation
all come from the same host. Nothing for them to configure.

### Render

1. Push this folder to GitHub.
2. Create a free account at <https://render.com>
3. **New → Web Service** → connect your repo.
4. **Root directory:** `red-key-server`
   **Build command:** `npm install`
   **Start command:** `npm start`
5. You'll get a URL like `https://red-key-xyz.onrender.com`.
   Share that URL — visiting it is the entire game.

### Railway

1. <https://railway.app> → New Project → Deploy from GitHub → pick this folder.
2. Railway autodetects Node + `npm start`. Add a public domain in Settings.
3. Share the resulting `https://<your-domain>` URL.

### Fly.io

```bash
cd red-key-server
fly launch     # accept defaults; pick a name + region
fly deploy
```

Share `https://<app-name>.fly.dev`.

### Glitch (easiest, free, but sleeps when idle)

1. <https://glitch.com> → New project → Import from GitHub (or drag this folder in).
2. Glitch runs `npm start` automatically.
3. Click **Share → Live App** for the URL.

## Admin override

If you (the admin) want a particular browser to talk to a *different* server
than the one that served the page — handy for testing two deployments — open
**Main Menu → Admin Panel → Game Server URL** and paste an override. Saved
in localStorage on that browser only. Click **Use auto-detected** to revert.

Regular players never see this panel and never see a URL anywhere.

## Protocol summary (for hacking)

Client → Server JSON messages:

| type             | payload                                       |
| ---------------- | --------------------------------------------- |
| `hello`          | `{ username, equipped: [3 players] }`         |
| `roster`         | `{ equipped: [3 players] }`                   |
| `queue`          | —                                             |
| `cancel-queue`   | —                                             |
| `invite`         | `{ to }`                                      |
| `invite-accept`  | `{ from }`                                    |
| `invite-decline` | `{ from }`                                    |
| `aims`           | `{ aims: {id:{x,y}}, ballAim:{x,y}, mode }`   |
| `qte-score`      | `{ round, score }`                            |
| `clash-dismiss`  | —                                             |
| `match-quit`     | —                                             |

Server → Client:

| type               | payload                                                |
| ------------------ | ------------------------------------------------------ |
| `welcome`          | `{ username, onlineCount }`                            |
| `online-count`     | `{ count }`                                            |
| `queued`           | —                                                      |
| `queue-cancelled`  | —                                                      |
| `incoming-invite`  | `{ from }`                                             |
| `invite-declined`  | `{ from }`                                             |
| `match-start`      | `{ matchId, opponent, role, players, state, turn }`    |
| `opponent-locked`  | —                                                      |
| `turn-state`       | `{ state }`                                            |
| `turn-end`         | `{ state, turn }`                                      |
| `kickoff`          | `{ side, state }`                                      |
| `goal`             | `{ side, scoreUs, scoreThem }`                         |
| `clash-start`      | `{ ctx: { moverId, opponentId } }`                     |
| `opp-qte-score`    | `{ round, score }`                                     |
| `clash-outcome`    | `{ outcome: { winnerId, loserId, throwAngle, throwDist, totalA, totalB } }` |
| `clash-dismiss`    | —                                                      |
| `match-end`        | `{ won, keys, scoreUs, scoreThem }`                    |
| `opponent-left`    | —                                                      |
| `error`            | `{ message }`                                          |
