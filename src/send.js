'use strict';

const { logger } = require('./logger');
const { renderPlanning } = require('./format');
const { describe, toJid } = require('./whatsapp/jid');

/**
 * Render the planning and deliver it to every configured recipient.
 * One recipient failing does not stop the others — a wrong number in the list
 * must not silently cost everyone else their planning.
 */
async function sendPlanning({ cfg, provider, planningSource }) {
  const planning = await planningSource.load();
  const parts = renderPlanning(planning, { upcomingOnly: cfg.upcomingOnly });

  logger.info(
    `Planning "${planning.title}": ${planning.plans.length} plan(s) from ${planningSource.name}, ` +
      `${parts.length} message part(s), ${cfg.recipients.length} recipient(s), provider ${provider.name}.`,
  );

  await provider.connect();

  const results = [];
  for (const recipient of cfg.recipients) {
    let jid;
    try {
      jid = toJid(recipient);
    } catch (err) {
      logger.error(`Skipping recipient "${recipient}": ${err.message}`);
      results.push({ recipient, ok: false, error: err.message });
      continue;
    }

    try {
      for (const part of parts) await provider.send(jid, part);
      results.push({ recipient: describe(jid), ok: true, parts: parts.length });
    } catch (err) {
      logger.error(`Failed sending to ${describe(jid)}: ${err.message}`);
      results.push({ recipient: describe(jid), ok: false, error: err.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  logger.info(`Delivered to ${results.length - failed.length}/${results.length} recipient(s).`);
  return { planning, parts, results, failed };
}

module.exports = { sendPlanning };
