'use strict';

const USER_SUFFIX = '@s.whatsapp.net';
const GROUP_SUFFIX = '@g.us';

/**
 * Turn a recipient from config into a WhatsApp JID.
 *   "+34 600 11 12 22"          -> "34600111222@s.whatsapp.net"
 *   "34600111222@s.whatsapp.net"-> unchanged
 *   "1203630000000@g.us"        -> unchanged (group)
 */
function toJid(recipient) {
  const raw = String(recipient || '').trim();
  if (!raw) throw new Error('Empty recipient');

  if (raw.endsWith(GROUP_SUFFIX) || raw.endsWith(USER_SUFFIX)) return raw;
  if (raw.includes('@')) throw new Error(`Unrecognised recipient JID: ${raw}`);

  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw new Error(
      `"${raw}" does not look like an E.164 phone number. ` +
        'Use the full international form, e.g. +34600111222.',
    );
  }
  return `${digits}${USER_SUFFIX}`;
}

function isGroup(jid) {
  return String(jid).endsWith(GROUP_SUFFIX);
}

/** Digits only, the form the Cloud API's `to` field wants. */
function toE164Digits(recipient) {
  const jid = toJid(recipient);
  if (isGroup(jid)) throw new Error(`${jid} is a group — the Cloud API cannot post to groups.`);
  return jid.slice(0, jid.indexOf('@'));
}

function describe(jid) {
  return isGroup(jid) ? `group ${jid}` : `+${String(jid).split('@')[0]}`;
}

module.exports = { toJid, isGroup, toE164Digits, describe, USER_SUFFIX, GROUP_SUFFIX };
