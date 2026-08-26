import { guard, json, callBot, explain, SEND_TIMEOUT_MS } from './_lib.js';

// The one route with a side effect nobody can undo. Everything narrowing the
// blast radius lives here or in the bot: session + custom header (guard),
// an explicit confirm token from the UI, and the bot's own rate limit.

export default async function handler(req, res) {
  if (!guard(req, res, { method: 'POST' })) return;

  const body = typeof req.body === 'object' && req.body ? req.body : {};

  // A real send must be asked for deliberately — never as a retry of a preview.
  if (body.dryRun !== true && body.confirm !== 'ENVIAR') {
    return json(res, 400, {
      error: 'confirm_required',
      message: 'A real send needs an explicit confirmation.',
    });
  }

  const recipients = Array.isArray(body.recipients)
    ? body.recipients.map((r) => String(r).trim()).filter(Boolean).slice(0, 50)
    : [];

  try {
    const { status, payload } = await callBot('/api/send', {
      method: 'POST',
      timeoutMs: SEND_TIMEOUT_MS,
      body: {
        dryRun: body.dryRun === true,
        upcomingOnly: body.upcomingOnly,
        exclude: Array.isArray(body.exclude) ? body.exclude.slice(0, 200) : [],
        ...(recipients.length ? { recipients } : {}),
      },
    });
    return json(res, status, payload);
  } catch (err) {
    const { status, body: errBody } = explain(err);
    return json(res, status, errBody);
  }
}
