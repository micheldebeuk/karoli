import { guard, json, callBot, explain } from './_lib.js';

export default async function handler(req, res) {
  if (!guard(req, res, { method: 'POST' })) return;

  const body = typeof req.body === 'object' && req.body ? req.body : {};
  try {
    const { status, payload } = await callBot('/api/preview', {
      method: 'POST',
      body: {
        exclude: Array.isArray(body.exclude) ? body.exclude.slice(0, 200) : [],
        upcomingOnly: body.upcomingOnly,
      },
    });
    return json(res, status, payload);
  } catch (err) {
    const { status, body: errBody } = explain(err);
    return json(res, status, errBody);
  }
}
