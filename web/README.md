# Consola Karolito — the Vercel site

The web console for the planes bot. Unlike the Claude Artifact version, this one
**can actually send**: a Vercel serverless function has real outbound network,
so it calls the bot's control API on the VPS.

```
browser ──cookie──▶ Vercel function ──bearer token──▶ bot on the VPS ──▶ WhatsApp
          (session)   /api/send                        POST /api/send
```

The browser never sees the control token, and the VPS never sees the console
password. Each hop has its own credential.

## Deploying

1. **Vercel → Add New → Project**, import `micheldebeuk/Plans`.
2. Set **Root Directory** to `web`. There is no build step and no framework —
   `index.html`, `styles.css` and `app.js` are served statically and `api/*.js`
   become Node functions.
3. Add the environment variables from `.env.example`:

   | Variable | What it is |
   | --- | --- |
   | `PLANES_VPS_URL` | `https://planes.losalidirect.com` — where the bot's control API answers. Must be HTTPS. |
   | `PLANES_CONTROL_TOKEN` | Same value as `PLANES_CONTROL_TOKEN` in the bot's `.env` |
   | `CONSOLE_PASSWORD` | The password that opens the console |
   | `SESSION_SECRET` | Signs the session cookie (`openssl rand -hex 32`) |
   | `SESSION_HOURS` | Optional, default 12 |

4. Deploy. The bot must be reachable at `PLANES_VPS_URL` first — see
   **Exposing the control API** in the main README.

## What guards it

A URL on the public internet that can send WhatsApp messages needs more than one
lock, so:

- **Password → signed session cookie.** `HttpOnly`, `Secure`, `SameSite=Strict`,
  HMAC-signed expiry. The password is compared in constant time and the answer
  never distinguishes "wrong password" from "not configured".
- **A custom header on every mutation.** `SameSite=Strict` already stops another
  site sending the cookie; requiring `X-Planes-Console: 1` means a forged request
  can never be a "simple" one that skips preflight.
- **An explicit confirmation for real sends.** `/api/send` refuses anything that
  is not a dry run unless the body carries `confirm: "ENVIAR"`, and the UI makes
  you click twice. A WhatsApp message cannot be unsent.
- **Rate limits on both sides.** Login attempts here, sends on the bot.
- **A strict CSP** (`vercel.json`): no inline script or style, `connect-src
  'self'`, `frame-ancestors 'none'`.

One weakness worth naming: the login throttle is in-memory, so it is per warm
serverless instance rather than global. It slows a guessing attack down but does
not stop a distributed one — which is why `CONSOLE_PASSWORD` should be long and
random, not memorable.

## Why the browser does not format messages

The bot renders the message with its own `src/format.js` and returns the finished
parts. The page just displays them. So there is no second implementation to drift
out of sync — the preview *is* the message, by construction rather than by test.

(The Claude Artifact version cannot do this: it has no route to the VPS, so it
re-implements the formatter and `tests/console.test.js` has to assert the two
stay identical.)

## Local development

```bash
npm i -g vercel
cd web && vercel dev
```

Point `PLANES_VPS_URL` at `http://127.0.0.1:3010` and run the bot locally with
`PLANES_CONTROL_ENABLED=1 node src/index.js listen --serve`.
