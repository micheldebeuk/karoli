import { guard, json, callBot, explain } from './_lib.js';

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  try {
    const { status, payload } = await callBot('/api/status');
    return json(res, status, payload);
  } catch (err) {
    const { status, body } = explain(err);
    return json(res, status, body);
  }
}
