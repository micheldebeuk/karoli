'use strict';

const { logger } = require('../logger');
const { toE164Digits } = require('./jid');

/**
 * Meta WhatsApp Cloud API transport.
 *
 * Official and stateless — nothing to pair, nothing to keep alive — but two
 * limits matter for this bot:
 *   * it cannot post to groups at all;
 *   * a message started outside the recipient's 24h service window must be an
 *     approved template, and template variables may not contain newlines, so a
 *     multi-line planning cannot go out that way. `send()` therefore tries the
 *     free-form text first and only falls back to the template (with a short
 *     one-line summary) when Meta rejects it for being outside the window.
 *
 * For a personal weekend-planning bot, WHATSAPP_PROVIDER=baileys is the better
 * fit. This provider exists so the app is not locked to the unofficial route.
 */
const TEMPLATE_VAR_MAX = 900;

function createCloudProvider(cfg) {
  const base = `https://graph.facebook.com/${cfg.cloud.apiVersion}/${cfg.cloud.phoneNumberId}/messages`;

  async function post(payload) {
    const res = await fetch(base, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.cloud.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        `Cloud API ${res.status}: ${(body.error && body.error.message) || 'unknown error'}`,
      );
      err.status = res.status;
      err.apiCode = body.error && body.error.code;
      err.apiSubcode = body.error && body.error.error_subcode;
      err.body = body;
      throw err;
    }
    return body;
  }

  // 131047 = "message outside the 24 hour window"; 131026 = undeliverable free-form.
  function needsTemplate(err) {
    return err.apiCode === 131047 || err.apiCode === 131026 || err.apiCode === 470;
  }

  /**
   * Templates reject newlines and tabs in variables, so the planning has to
   * become one clean line. Paragraph breaks turn into a visible separator;
   * every other whitespace character — a lone tab included — collapses to a
   * single space. Meta caps a variable's length, so it is truncated too, and
   * a separator must never be left dangling at either end.
   */
  const EDGE_SEPARATORS = /^(?:\s*·\s*)+|(?:\s*·\s*)+$/g;

  function flatten(text) {
    const oneLine = String(text)
      .replace(/\s*\n+\s*/g, ' · ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(EDGE_SEPARATORS, '');
    // Truncating can expose a new trailing separator, so tidy the edges again.
    return oneLine.slice(0, TEMPLATE_VAR_MAX).trim().replace(EDGE_SEPARATORS, '');
  }

  return {
    name: 'cloud',
    supportsGroups: false,
    supportsIncoming: false, // inbound needs a public webhook — out of scope here

    isRegistered: () => Boolean(cfg.cloud.token && cfg.cloud.phoneNumberId),

    async connect() {
      return null; // stateless
    },

    async send(recipient, text) {
      const to = toE164Digits(recipient);
      try {
        const res = await post({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: true, body: text },
        });
        logger.info(`Sent to +${to} (${text.length} chars, id ${messageId(res)})`);
        return res;
      } catch (err) {
        if (!needsTemplate(err)) throw err;
        if (!cfg.cloud.templateName) {
          throw Object.assign(
            new Error(
              `+${to} is outside the 24h window and WA_CLOUD_TEMPLATE_NAME is not set, ` +
                'so nothing could be delivered. Set an approved template, or use ' +
                'WHATSAPP_PROVIDER=baileys.',
            ),
            { cause: err },
          );
        }

        logger.warn(`+${to} is outside the 24h window — falling back to template "${cfg.cloud.templateName}".`);
        const res = await post({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: cfg.cloud.templateName,
            language: { code: cfg.cloud.templateLang },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: flatten(text) }] },
            ],
          },
        });
        logger.info(`Sent template to +${to} (id ${messageId(res)})`);
        return res;
      }
    },

    async reply() {
      throw new Error('Inbound replies need a webhook; not supported by the cloud provider here.');
    },
    onMessage() {
      throw new Error(
        'The Cloud API delivers inbound messages via webhook, not a socket. ' +
          'Use WHATSAPP_PROVIDER=baileys for the interactive bot.',
      );
    },
    async listGroups() {
      throw new Error('The Cloud API has no notion of groups.');
    },
    async whoami() {
      return { id: cfg.cloud.phoneNumberId, provider: 'cloud' };
    },
    async close() {},
  };
}

function messageId(res) {
  return (res && res.messages && res.messages[0] && res.messages[0].id) || '?';
}

module.exports = { createCloudProvider };
