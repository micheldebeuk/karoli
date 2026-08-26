import { guard, json, callBot, explain } from './_lib.js';

// The bot renders the message itself, so the browser never re-implements
// src/format.js and the preview cannot drift from what actually gets sent.
export default async function handler(req, res) {
  if (!guard(req, res)) return;
  try {
    const { status, payload } = await callBot('/api/planning');
    return json(res, status, payload);
  } catch (err) {
    const { status, body } = explain(err);
    return json(res, status, body);
  }
}
