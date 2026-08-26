'use strict';

/**
 * Command grammar (case-insensitive, an optional leading "/" or "!" is fine):
 *
 *   PLANES              -> resend the current planning
 *   AYUDA | HELP        -> command list
 *   E1                  -> detail of one plan
 *   E1 SI | E1 NO       -> vote on one plan
 *
 * Anything else is ignored on purpose: in a group chat the bot must stay quiet
 * rather than answer every message.
 */

const YES = /^(si|sí|s|yes|y|ok|vale|1|👍|✅)$/i;
const NO = /^(no|n|nope|0|👎|❌)$/i;
const PLAN_ID = /^[a-z]{1,3}\d{1,3}$/i;

function parseCommand(text) {
  const cleaned = String(text || '').trim().replace(/^[!/]+/, '');
  if (!cleaned) return null;

  const words = cleaned.split(/\s+/);
  const head = words[0].toLowerCase();

  if (/^(planes|plan|planning|lista)$/.test(head)) return { kind: 'planning' };
  if (/^(ayuda|help|comandos|\?)$/.test(head)) return { kind: 'help' };

  if (PLAN_ID.test(words[0])) {
    const id = words[0].toUpperCase();
    if (words.length === 1) return { kind: 'detail', id };
    const answer = words.slice(1).join(' ').trim();
    if (YES.test(answer)) return { kind: 'vote', id, value: 'si' };
    if (NO.test(answer)) return { kind: 'vote', id, value: 'no' };
    return { kind: 'unknown-vote', id, answer };
  }

  return null;
}

const HELP_TEXT = [
  '*Comandos del bot de planes*',
  '',
  '*PLANES* — vuelve a enviar la lista del finde',
  '*E1* — detalle de un plan concreto',
  '*E1 SI* / *E1 NO* — vota ese plan',
  '*AYUDA* — este mensaje',
].join('\n');

module.exports = { parseCommand, HELP_TEXT, YES, NO };
