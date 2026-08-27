# Saving this as the standalone `karoli` repository

All of this lives under `plans/` in the `losali` repo on the branch
`claude/whatsapp-bot-planes-o0n32n`, because the GitHub App backing that session
is scoped to `micheldebeuk/losali` and **cannot create repositories**
(`403 Resource not accessible by integration`). Nothing here depends on the
surrounding repo — `plans/` *is* the whole app — so moving it out is a copy, not
a refactor.

Both routes below were run end to end before being written down.

## 1. Create the repository

Done: **`micheldebeuk/karoli`**, private and empty.

If you ever redo this, create it with **no** README, `.gitignore` or licence —
an empty repo keeps the first push clean. (A repo initialised with a README
rejects the push below as a non-fast-forward; the fix is to `git pull --rebase`
first, or force-push over the placeholder commit.)

The repo name is the one thing to get right in the commands below — a wrong
name fails as `remote: Repository not found`, which reads like a permissions
problem but usually is not.

## 2. Get the code into it

### Option A — keep the history (recommended)

`git subtree split` rewrites the `plans/` subdirectory into its own branch whose
files sit at the root. Verified here: 5 commits, correct tree.

```bash
git clone https://github.com/micheldebeuk/losali.git
cd losali
git checkout claude/whatsapp-bot-planes-o0n32n

git subtree split --prefix=plans -b plans-only
git push https://github.com/micheldebeuk/karoli.git plans-only:main
git branch -D plans-only
```

### Option B — a clean single commit

```bash
cd losali/plans
rm -rf .git 2>/dev/null   # there isn't one; this is just belt and braces
git init -b main
git add .
git commit -m "WhatsApp bot for Planes de Fin de Semana"
git remote add origin https://github.com/micheldebeuk/karoli.git
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `data/` (the WhatsApp session and
the ask queue) and every `.env` — check `git status` before the first commit
anyway.

## 3. Remove it from `losali`

Once `karoli` has the code, the copy under `losali/plans/` is redundant:

```bash
cd losali
git checkout claude/whatsapp-bot-planes-o0n32n
git rm -r plans
git commit -m "Move the planes WhatsApp bot to its own Plans repository"
git push
```

## 4. Then

Follow **Deploying to the Losali VPS** in `README.md`. Two things to carry over:

- The clone path is `/home/ubuntu/plans`, deliberately **not** inside
  `/home/ubuntu/losali` — the losali deploy cron hard-resets its own checkout to
  `origin/main` and would wipe an app living inside it.
- `.github/workflows/vps.yml` targets the self-hosted runner labelled
  `losali-vps`, which is registered against `losali` only. Register it for
  `karoli` too (Settings → Actions → Runners → New self-hosted runner, adding
  `--labels losali-vps`), or promote it to an organisation runner.

## What is in here

| Path | What |
| --- | --- |
| `src/` | the bot: WhatsApp transports, planning sources, formatter, control API, `claude -p` worker |
| `web/` | the Vercel console — the one that can actually send |
| `console/` | the Claude Artifact console — the one that reads the live sheet |
| `deploy/` | VPS install/update scripts and the nginx vhost |
| `docs/ROUTINE.md` | Route B: the scheduled Routine that feeds the planning |
| `tests/` | 145 tests, no network, no WhatsApp session, no Claude usage |

## Secrets that must never reach the repo

| What | Where it belongs |
| --- | --- |
| `data/wa-session/` | the VPS only — these files *are* the linked WhatsApp device |
| `PLANES_CONTROL_TOKEN` | the bot's `.env` and the Vercel project |
| `CONSOLE_PASSWORD`, `SESSION_SECRET` | the Vercel project |
| The Claude OAuth credential (`claude setup-token`) | the VPS user's home, never copied |

All are gitignored. None appear in any committed file.
