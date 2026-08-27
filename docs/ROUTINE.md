# Route B — the scheduled Routine that feeds the planning

A Claude Routine fires on a schedule, reads **Planes Karolito** with *your own*
Google Drive connector, and POSTs the rows to the bot. The point: no Google
service account, no OAuth client, no Google credentials anywhere on the VPS.

It runs on your **Claude subscription** — a Routine fires a normal Claude Code
cloud session, which authenticates by OAuth (`authMethod: "oauth_token"`), not
by API key.

## Frequency

**One hour is the floor.** The scheduler rejects anything shorter:

```
cron expression "* * * * *" may fire runs as little as 1 minute apart;
the minimum interval is 1 hour
```

Cron is the standard 5 fields and is evaluated in **UTC** — convert from Madrid
first (19:00 Madrid in summer is `0 17 * * *`). Firings are anchored to the
minute you created the Routine so they spread across the hour, so don't expect
to-the-second precision.

For a weekend planning, once or twice a week is plenty:

| Cron (UTC) | Madrid (summer) | Why |
| --- | --- | --- |
| `0 7 * * 4` | Thu 09:00 | Refresh before the Thursday 19:00 send |
| `0 7 * * 4,6` | Thu + Sat 09:00 | Also picks up votes added midweek |

## Setting it up

Prerequisites: the bot is running with `PLANNING_SOURCE=pushed`, and its control
API is reachable over HTTPS (see the main README).

Create the Routine from a Claude Code session with:

- **mode**: fresh session per firing (`create_new_session_on_fire: true`)
- **connectors**: `["Google Drive"]`
- **cron**: `0 7 * * 4`
- **prompt**: the block below, with the token filled in

```
Read the Google Sheet "Planes Karolito"
(id 1Nvnh1YvoEMrZgFIpInuQNvqck8vX6fN2XNKva7KW2QY) with the Google Drive
connector, and push it to the planes bot.

1. Read the file. It comes back as a markdown table. The header row is NOT the
   first row — a blank row and an alignment row sit above it. Find the row whose
   cells include "ID" and "Plan"; that is the header.
2. Build one JSON object per data row, keyed by those column titles:
   ID, Plan, Categoria, Tipo, Dia propuesto, Horario, Estado, Voto Olivier,
   Voto Karina, Fecha del voto, Enlace oficial, Google Maps, Notas.
   Undo the backslash escapes the connector adds (\& becomes &) or every
   Google Maps link will be broken. Skip blank rows.
3. POST them:
   curl --connect-timeout 10 --max-time 30 -s -w '\n%{http_code}\n' \
     -X POST https://planes.losalidirect.com/api/planning/import \
     -H 'Authorization: Bearer PUT_PLANES_CONTROL_TOKEN_HERE' \
     -H 'Content-Type: application/json' \
     --data @payload.json
   where payload.json is {"plans":[ ...those objects... ]}.
4. Print the HTTP code and how many plans you sent. If the sheet yields zero
   rows, send NOTHING and say so — the bot rejects an empty push on purpose, so
   that a bad read cannot wipe a good planning.

Do not invent rows. If the sheet cannot be read, say so and stop.
```

The token is a credential: a Routine prompt is stored server-side, which is
acceptable, but rotate it if you ever share the Routine.

## Checking it works

```bash
# on the VPS
curl -s -H "Authorization: Bearer $PLANES_CONTROL_TOKEN" \
     http://127.0.0.1:3010/api/status | grep -o '"kind":"import"[^}]*'
```

`/api/status` keeps the last 20 events, so a successful import shows up there,
and the web console's "Últimos envíos" panel shows them too.

## What it does not do yet

Write votes back. `recordVote()` on the pushed source throws a clear
"not implemented" — the Routine would need a second step that writes the
*Voto Olivier* / *Voto Karina* / *Fecha del voto* cells back to the sheet.
