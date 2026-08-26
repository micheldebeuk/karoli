# Publishing this as the standalone `Plans` repository

This app was written as a self-contained tree under `plans/` in the `losali`
repo because the GitHub App backing that session is scoped to `micheldebeuk/losali`
and cannot create new repositories (`403 Resource not accessible by integration`).
Nothing here depends on the surrounding repo — `plans/` **is** the whole app, so
moving it out is a copy, not a refactor.

## 1. Create the repository

On GitHub: **New repository → `Plans`** (private), *without* a README,
`.gitignore` or licence — an empty repo, so the first push is clean.

## 2. Push this directory into it

From a checkout of `losali` on the branch carrying this work:

```bash
cd plans
git init -b main
git add .
git commit -m "WhatsApp bot for Planes de Fin de Semana"
git remote add origin https://github.com/micheldebeuk/Plans.git
git push -u origin main
```

That gives `Plans` a clean single-commit history. If you would rather keep the
commit history from `losali`, use a subtree split instead:

```bash
# from the root of the losali checkout
git subtree split --prefix=plans -b plans-only
git push https://github.com/micheldebeuk/Plans.git plans-only:main
git branch -D plans-only
```

## 3. Remove it from `losali`

Once `Plans` has the code, the copy under `losali/plans/` is redundant and
should go, so there is only one source of truth:

```bash
git rm -r plans
git commit -m "Move the planes WhatsApp bot to its own Plans repository"
```

## 4. Then

Follow **Deploying to the Losali VPS** in `README.md`. The clone path there is
`/home/ubuntu/plans`, which is deliberately *not* inside `/home/ubuntu/losali` —
the losali deploy cron hard-resets its own checkout to `origin/main`, and an app
living inside it would be wiped.

Remember the runner note in `README.md`: `.github/workflows/vps.yml` targets the
self-hosted runner labelled `losali-vps`, which is currently registered against
the `losali` repository only. Register it for `Plans` as well, or promote it to
an organisation runner, before dispatching that workflow.
