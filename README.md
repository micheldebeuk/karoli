# Planes — WhatsApp bot for *Planes de Fin de Semana*

A small Node app that sends our weekend planning to WhatsApp and answers back.
It runs on the **Losali VPS** under pm2, next to the losali proxy.

```
Google Sheets ──▶ planning source ──▶ formatter ──▶ WhatsApp transport ──▶ us
 "Planes Karolito"   (src/planning)   (src/format)   (src/whatsapp)
        ▲                                                   │
        └──────────────── votes ◀──── bot commands ◀─────────┘
                                      (src/bot)
```

**Status: the WhatsApp half is done. The Google half is not.**
Everything from "planning source" rightwards works today, running off a snapshot
of the sheet in `fixtures/planning.json`. Reading the live sheet — and writing
votes back into it — is the next milestone; see [What's left](#whats-left).

---

## Quick start

```bash
npm install
cp .env.example .env      # then edit it
npm run preview           # render the planning to stdout — sends nothing
npm run login -- --pair +34600111222   # link this machine to WhatsApp, once
npm run send              # send it for real
npm run listen            # run the bot: answer PLANES / votes
```

`npm run preview` needs no configuration and no WhatsApp session, so it is the
fastest way to see what the message will look like:

```
*Planes de Fin de Semana*
_Sábado 29 y domingo 30 de agosto_

*SABADO 29/08/2026*

🏖️ *E1 · Caldes d'Estrac (Caldetes)*
🕒 09:30-14:00 · Escapada - mar y playa
👶 Con el peque
📝 R1 desde Arc de Triomf 50-55 min. Fundacio Palau al lado. Carrito OK.
🔗 https://caldetes.cat/turisme
📍 https://www.google.com/maps/search/?api=1&query=Platja+dels+Tres+Micos...
```

## Commands

| Command | What it does |
| --- | --- |
| `preview` | Render the planning to stdout. No session, no sending. |
| `send` | Send the planning to everyone in `WHATSAPP_RECIPIENTS`. |
| `login [--qr \| --pair +34…]` | Link this machine to WhatsApp. Once, per machine. |
| `listen` | Stay connected and answer commands from the chat. |
| `status [--groups]` | Print config + session state. `--groups` lists group JIDs. |

Flags: `--dry-run` renders and logs without sending; `--all` includes plans
outside the upcoming weekend.

## What the bot answers

From any chat it is in:

| You send | It does |
| --- | --- |
| `PLANES` | Re-sends the current planning |
| `E1` | Detail of that one plan |
| `E1 SI` / `C2 NO` | Records your vote |
| `AYUDA` | The command list |

Anything else is ignored on purpose — in a group the bot has to stay quiet
rather than answer every message.

Votes are attributed by phone number via `PLANNING_VOTERS`. A number that is not
listed gets a polite refusal instead of a silently discarded vote. Until the
Google writer lands, a vote is acknowledged as *"anotado, pero todavía no se
guarda en la hoja"* — the bot never claims to have saved something it didn't.

## Choosing a transport

`WHATSAPP_PROVIDER` picks how messages go out:

| Value | Notes |
| --- | --- |
| **`baileys`** (default) | WhatsApp Web multi-device. Free, arbitrary formatted text, **works with groups**, and can receive messages — so the interactive bot needs this one. Requires a one-time device pairing and a session directory that lives on the VPS. Unofficial: Meta does not support it, and it can break when WhatsApp Web changes. |
| `cloud` | Meta's official WhatsApp Cloud API. Nothing to pair. But it **cannot post to groups**, and a message sent outside the recipient's 24-hour window must be an approved template whose variables cannot contain newlines — so a multi-line planning cannot go out that way. Inbound needs a public webhook, which this app does not serve. |
| `dry-run` | Renders and logs, sends nothing. |

For a personal weekend-planning bot posting into our chat, `baileys` is the
right fit; `cloud` is there so the app is not locked to the unofficial route.

### The session directory is a credential

`data/wa-session/` **is** the linked device. Anyone holding those files can send
WhatsApp messages as that account. It is gitignored, created `0700`, and must
never be committed, copied around, or pasted into a log. To revoke: WhatsApp →
Linked devices → remove the device, then `rm -rf data/wa-session`.

## Configuration

Everything is environment variables; `.env.example` documents each one. The ones
that matter most:

| Variable | Meaning |
| --- | --- |
| `WHATSAPP_RECIPIENTS` | Comma-separated E.164 numbers and/or group JIDs (`…@g.us`). Find group JIDs with `npm run status -- --groups`. |
| `WHATSAPP_PROVIDER` | `baileys` \| `cloud` \| `dry-run` |
| `PLANNING_VOTERS` | `+34600111222=Olivier,+34600333444=Karina` |
| `PLANNING_SOURCE` | `fixture` (today) \| `google-sheets` (not implemented) |
| `PLANNING_UPCOMING_ONLY` | Only send plans falling on the coming Sat/Sun. |
| `DRY_RUN` | `1` to render without sending, whatever the provider. |

Timing knobs, all with sane defaults: `WHATSAPP_CONNECT_TIMEOUT_MS` (60s — an
unattended send must fail rather than hang), `WHATSAPP_PAIR_TIMEOUT_MS` (240s,
since a login waits on a human), `WHATSAPP_MAX_RECONNECTS` (5),
`WHATSAPP_RECONNECT_BASE_MS` (2s, doubling, capped at 30s),
`WHATSAPP_PAIR_HANDSHAKE_MS` (3s) and `WHATSAPP_SEND_DELAY_MS` (900ms between
consecutive sends).

Config is validated before anything is sent, so a group JID on the Cloud API or
an empty recipient list fails immediately with a readable message rather than
half-way through a send.

## Deploying to the Losali VPS

The app runs under pm2 as two processes (`ecosystem.config.js`):

* **`planes-bot`** — always on: `listen --serve`. Holds the WhatsApp session,
  answers commands, and serves the control API.
* **`planes-weekly`** — one shot, Thursdays 19:00 Europe/Madrid: `dispatch`,
  then exits.

> **Why `dispatch` and not `send`.** The Baileys session directory is a single
> linked device. Two processes opening it at once fight over the Signal key
> state until WhatsApp logs the device out. So exactly one process owns the
> socket, and the weekly job — like the web console — asks it to send over the
> control API instead of opening a connection of its own.

```bash
# on the VPS, as ubuntu
git clone https://github.com/micheldebeuk/karoli.git /home/ubuntu/plans
/home/ubuntu/plans/deploy/install.sh          # deps, .env, syntax check
cd /home/ubuntu/plans
nano .env                                     # fill it in
npm run login -- --pair +34600111222          # link the device, once
pm2 start ecosystem.config.js && pm2 save
```

`deploy/update.sh` is the per-minute cron shape used by the losali proxy: it
does nothing when already current, runs `npm ci` only when the manifest changed,
and refuses to restart into a tree that does not parse.

```cron
* * * * * /home/ubuntu/plans/deploy/update.sh >> /home/ubuntu/plans/logs/update.log 2>&1
```

### Driving the VPS without SSH

`.github/workflows/vps.yml` runs on the self-hosted runner labelled
`losali-vps`, the same channel `losali` uses for proxy work. Dispatch it with an
`action` of `status`, `install`, `update`, `send`, `send-dry-run`, `restart`,
`logs`, `groups` or `login`.

> **One-time setup:** that runner is registered against the `losali` repository.
> Register it for this repository too (Settings → Actions → Runners → New
> self-hosted runner, adding `--labels losali-vps`), or promote it to an
> organisation runner shared by both. Until then dispatched runs simply queue.

## Asking Claude from the chat (Route A)

Reply in WhatsApp and get an answer, billed to your **Claude subscription** —
not the API. The bot shells out to Claude Code headless (`claude -p`).

```bash
# once, as the user pm2 runs as
claude setup-token      # its own help: "requires Claude subscription"
claude auth status      # must report "authMethod": "oauth_token"
```

Then `PLANES_ASK_ENABLED=1`. How it behaves:

- **One-to-one chat** with a number in `PLANNING_VOTERS`: any non-command
  message is a question.
- **In a group**: only when named — `Claude, ¿que tiempo hara el sabado?`.
  Otherwise the bot stays silent, as it should in a group.
- **Strangers are never answered.**

Questions go to a durable on-disk queue and are answered whenever they can be.
That is the design, not a limitation: subscription limits are windowed, so a
question may legitimately wait — the queue survives restarts and reboots and
backs off for half an hour when a limit is hit, without saying anything in the
chat.

Three things keep this safe and on the subscription:

- **No tools at all.** `--allowedTools ""` and `--permission-mode manual`. Anyone
  who can message the number puts text in front of the model, so it gets no
  Bash, no filesystem, no network — the whole injection class is removed.
- **The API key is stripped from the child's environment.** A stray
  `ANTHROPIC_API_KEY` can shadow the OAuth credential and silently move you onto
  per-token billing. `--bare` is never passed either, for the same reason.
- **A daily cap** (`PLANES_ASK_DAILY_LIMIT`, default 25). The bot draws from the
  same pool as your own Claude Code work.

Each WhatsApp chat maps to a stable Claude session id, so a thread is one
continuing conversation rather than a cold start per message.

## The control API

`planes-bot` serves a small HTTP API so other things can drive it without
touching the WhatsApp session:

| Route | Auth | What |
| --- | --- | --- |
| `GET /api/health` | none | liveness for the reverse proxy; leaks no config |
| `GET /api/status` | bearer | transport, link state, recipients, recent sends |
| `GET /api/planning` | bearer | the plans plus the exact rendered message parts |
| `POST /api/preview` | bearer | re-render with exclusions / weekend toggle |
| `POST /api/send` | bearer | send, honouring `dryRun`, `recipients`, `exclude` |
| `POST /api/planning/import` | bearer | Route B: accept a planning pushed by a Routine |
| `GET /api/groups` | bearer | group JIDs |

Set `PLANES_CONTROL_TOKEN` (24+ chars) — the server refuses to start without
one. It binds to `127.0.0.1` by default.

### Exposing the control API

Only needed for the Vercel console. Put TLS in front of it, exactly as the
losali proxy does for `api.losalidirect.com` — there is a ready nginx vhost at
[`deploy/planes.losalidirect.com.conf`](deploy/planes.losalidirect.com.conf).
Never bind the bot itself to a public interface: the bearer token is the only
credential and plain HTTP would put it on the wire.

## Getting the sheet in without Google credentials (Route B)

`PLANNING_SOURCE=pushed` lets a scheduled **Claude Routine** read *Planes
Karolito* with your own Google Drive connector and POST it to
`/api/planning/import`. No service account, no OAuth client, nothing Google on
the VPS — and it runs on your subscription too.

The scheduler's floor is **one hour** (measured: a shorter cron is rejected with
*"the minimum interval is 1 hour"*), which is ample for a weekend planning.
Setup, the exact Routine prompt and the cron are in
[`docs/ROUTINE.md`](docs/ROUTINE.md).

An empty push is refused on purpose: a bad read must never wipe a good planning.

## Two consoles

| | Claude Artifact | Vercel site (`web/`) |
| --- | --- | --- |
| Reads the **live Google Sheet** | yes, via your Drive connector | no — via the bot's source |
| **Sends** | no — a published page has no route to the VPS | **yes** |
| Formats the message | re-implements `src/format.js`, kept honest by `tests/console.test.js` | the bot renders it; nothing to drift |
| Access | private to you on claude.ai | password + signed session cookie |

They complement each other: the artifact is the one that can see today's sheet,
the site is the one that can press send. See [`web/README.md`](web/README.md).

## Layout

```
src/
  index.js              CLI: preview | send | login | listen | status
  config.js             env -> config, with validation before any send
  format.js             planning -> WhatsApp message parts (splits, numbers them)
  send.js               deliver to every recipient, isolating failures
  logger.js             tiny logger + a pino-shaped shim for Baileys
  planning/
    index.js            source factory: fixture (now) | google-sheets (TODO)
    schema.js           the Plan shape, sheet-column mapping, date/weekend logic
  whatsapp/
    index.js            transport factory
    baileys.js          WhatsApp Web multi-device (send + receive + groups)
    cloud.js            Meta Cloud API (send only, no groups)
    dryrun.js           records instead of sending
    jid.js              phone number <-> JID
  bot/
    index.js            command routing, vote attribution
    commands.js         the command grammar
  server.js             control API, in-process with the bot
web/                    the Vercel console (static page + serverless functions)
console/                the Claude Artifact console
deploy/                 install / update scripts, nginx vhost
```

## Tests

```bash
npm test      # node:test — no network, no WhatsApp session, no phone
npm run check # syntax check every file
```

87 tests, and they run **without `npm install`**: `src/whatsapp/baileys.js`
requires its client lazily, and the transport tests substitute a fake for it
entirely, so CI covers everything without pulling the heavy dependency.

What is covered:

| Area | How |
| --- | --- |
| Formatting, pagination, weekend filtering | Directly, against the real sheet columns |
| Command grammar, bot routing, vote attribution | Fake provider + fake planning source |
| Config validation | Real env parsing |
| Delivery, per-recipient failure isolation | Fake provider |
| **Cloud transport** | `globalThis.fetch` stubbed: payload shape, the 24h-window template fallback, variable flattening, error surfacing |
| **Baileys transport** | `tests/fake-baileys.js` drives the connection state machine: open, QR, pairing codes, logged-out, backoff and reconnect, retry-budget reset, timeout, inbound parsing |

**What is not covered, and cannot be without a real handset:** that a message
actually arrives, that the bold/emoji render as intended in the WhatsApp client,
that pairing completes, and that a group JID resolves. The tests prove this code
behaves correctly against a faithful stand-in — not that WhatsApp accepts it.
The first genuine proof is the pairing run on the VPS; `send --dry-run` shows
the exact bytes beforehand.

## Consola Karolito

A published Claude Artifact reads the **live** sheet through the viewer's Google
Drive connector and previews the exact message the bot would send — day
grouping, vote marks, the 3500-character split and all — then hands over the
command to run. It curates plans, exports `planning.json` for this repo, and
generates the `.env` lines.

It cannot press send: a published page has no network route to the VPS. See
[`console/README.md`](console/README.md). `tests/console.test.js` asserts the
preview stays byte-for-byte identical to `src/format.js`.

## What's left

The Google half, in `src/planning/index.js` (`googleSheetsSource`), which today
throws a clear "not implemented" instead of pretending:

1. Authenticate to Google (service account, or an OAuth refresh token for the
   account owning the sheet).
2. `GET spreadsheets/{PLANNING_SHEET_ID}/values/{PLANNING_SHEET_RANGE}`.
3. Pass the raw `values` array to `schema.rowsToPlans()` and the result to
   `normalizePlanning()` — the column-title mapping, date parsing and weekend
   filtering are already done and tested.
4. Implement `recordVote()` to write the *Voto Olivier* / *Voto Karina* /
   *Fecha del voto* cells of the matching `ID` row.

Nothing downstream has to change: the bot already calls `recordVote()` and
already reports honestly when the source is read-only.

The sheet is **Planes Karolito**
(`1Nvnh1YvoEMrZgFIpInuQNvqck8vX6fN2XNKva7KW2QY`), columns:

```
ID | Plan | Categoria | Tipo | Dia propuesto | Horario | Estado |
Voto Olivier | Voto Karina | Fecha del voto | Enlace oficial | Google Maps | Notas
```
