#!/usr/bin/env node
'use strict';

const { load, validateForSend } = require('./config');
const { logger } = require('./logger');
const { createWhatsAppProvider } = require('./whatsapp');
const { createPlanningSource } = require('./planning');
const { renderPlanning } = require('./format');
const { sendPlanning } = require('./send');
const { createBot } = require('./bot');
const { createControlServer } = require('./server');

const USAGE = `
planes — WhatsApp bot for "Planes de Fin de Semana"

  node src/index.js <command> [options]

Commands
  preview                 Render the planning to stdout. Sends nothing, needs no session.
  send                    Send the planning to WHATSAPP_RECIPIENTS.
  login [--qr|--pair N]   Link this machine to WhatsApp (baileys provider only).
                            --qr          print a QR to scan (default)
                            --pair +34…   get an 8-character pairing code instead
  listen [--serve]        Run the bot: stay connected and answer commands.
                            --serve  also expose the control API (see README)
  dispatch [--dry-run]    Ask the RUNNING bot to send, over its control API.
                            This is what the weekly cron uses: it must not open
                            a second WhatsApp session of its own.
  status [--groups]       Show config + session state. --groups lists group JIDs.

Options
  --dry-run               Render and log, never send (same as DRY_RUN=1).
  --all                   Include plans outside the upcoming weekend.
  -h, --help              This message.
`.trim();

function parseArgv(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pair') {
      args.flags.pair = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[(i += 1)] : true;
    } else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args.flags[k] = v === undefined ? true : v;
    } else if (a === '-h') {
      args.flags.help = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const command = args._[0] || 'help';

  if (args.flags.help || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const cfg = load();
  if (args.flags['dry-run']) cfg.dryRun = true;
  if (args.flags.all) cfg.upcomingOnly = false;

  switch (command) {
    case 'preview':
      return cmdPreview(cfg);
    case 'send':
      return cmdSend(cfg);
    case 'login':
      return cmdLogin(cfg, args);
    case 'listen':
      return cmdListen(cfg, args);
    case 'dispatch':
      return cmdDispatch(cfg, args);
    case 'status':
      return cmdStatus(cfg, args);
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
      return 2;
  }
}

async function cmdPreview(cfg) {
  const planningSource = createPlanningSource(cfg);
  const planning = await planningSource.load();
  const parts = renderPlanning(planning, { upcomingOnly: cfg.upcomingOnly });
  parts.forEach((part, i) => {
    if (parts.length > 1) process.stdout.write(`\n----- message ${i + 1}/${parts.length} -----\n`);
    process.stdout.write(`${part}\n`);
  });
  return 0;
}

async function cmdSend(cfg) {
  validateForSend(cfg);
  const provider = createWhatsAppProvider(cfg);
  const planningSource = createPlanningSource(cfg);
  try {
    const { failed } = await sendPlanning({ cfg, provider, planningSource });
    return failed.length ? 1 : 0;
  } finally {
    await provider.close();
  }
}

async function cmdLogin(cfg, args) {
  if (cfg.provider !== 'baileys') {
    logger.error(`Nothing to link: the "${cfg.provider}" provider has no device session.`);
    return 2;
  }
  const provider = createWhatsAppProvider(cfg);
  const mode = args.flags.pair ? 'code' : 'qr';
  const number = typeof args.flags.pair === 'string' ? args.flags.pair : undefined;
  if (mode === 'code' && !number) {
    logger.error('--pair needs the phone number of the WhatsApp account, e.g. --pair +34600111222');
    return 2;
  }
  try {
    await provider.login({ mode, number });
    return 0;
  } finally {
    await provider.close();
  }
}

async function cmdListen(cfg, args = { flags: {} }) {
  validateForSend(cfg);
  const provider = createWhatsAppProvider(cfg);
  const planningSource = createPlanningSource(cfg);
  const bot = createBot({ cfg, provider, planningSource });

  await bot.start();

  // The control API lives in this process on purpose: it is the one that holds
  // the WhatsApp session, and a second process opening the same session
  // directory corrupts it.
  let control = null;
  if (cfg.control.enabled || args.flags.serve) {
    control = createControlServer({ cfg, provider, planningSource });
    await control.listen();
  }

  await new Promise((resolve) => {
    const stop = (signal) => {
      logger.info(`Received ${signal}, shutting down.`);
      Promise.resolve(control ? control.close() : null)
        .catch(() => {})
        .then(() => provider.close())
        .finally(resolve);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
  return 0;
}

/**
 * Ask the running bot to send. The weekly cron uses this instead of `send`:
 * `send` opens its own WhatsApp connection, and two processes sharing one
 * session directory fight over the Signal keys until the device is logged out.
 */
async function cmdDispatch(cfg, args) {
  if (!cfg.control.token) {
    logger.error('PLANES_CONTROL_TOKEN is not set, so there is no running bot to ask.');
    return 2;
  }
  const url = `http://${cfg.control.host}:${cfg.control.port}/api/send`;
  const payload = {
    dryRun: Boolean(args.flags['dry-run']) || cfg.dryRun,
    upcomingOnly: args.flags.all ? false : cfg.upcomingOnly,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.control.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.control.dispatchTimeoutMs),
    });
  } catch (err) {
    logger.error(
      `Could not reach the bot's control API at ${url}: ${err.message}. ` +
        'Is `planes-bot` running with PLANES_CONTROL_ENABLED=1?',
    );
    return 1;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 207) {
    logger.error(`Control API refused the send (${res.status}): ${body.message || body.error || 'unknown'}`);
    return 1;
  }
  logger.info(
    `Dispatched: ${body.delivered}/${body.delivered + body.failed} recipient(s), ` +
      `${body.parts} part(s)${body.dryRun ? ' (dry run)' : ''}.`,
  );
  return body.failed ? 1 : 0;
}

async function cmdStatus(cfg, args) {
  const provider = createWhatsAppProvider(cfg);
  const planningSource = createPlanningSource(cfg);

  process.stdout.write(
    [
      `env file        ${cfg.envFile || '(none — using process env)'}`,
      `provider        ${provider.name}`,
      `planning source ${planningSource.name}`,
      `recipients      ${cfg.recipients.length ? cfg.recipients.join(', ') : '(none configured)'}`,
      `voters          ${Object.entries(cfg.voters).map(([k, v]) => `${v}=+${k}`).join(', ') || '(none)'}`,
      `timezone        ${cfg.timezone}`,
      `upcoming only   ${cfg.upcomingOnly}`,
      `dry run         ${cfg.dryRun}`,
      `session linked  ${provider.isRegistered()}`,
      '',
    ].join('\n'),
  );

  try {
    const planning = await planningSource.load();
    process.stdout.write(`planning        ${planning.plans.length} plan(s) — "${planning.title}"\n`);
  } catch (err) {
    process.stdout.write(`planning        UNAVAILABLE: ${err.message}\n`);
  }

  if (args.flags.groups) {
    try {
      const groups = await provider.listGroups();
      process.stdout.write('\nGroups this account is in (use the JID in WHATSAPP_RECIPIENTS):\n');
      for (const g of groups) process.stdout.write(`  ${g.jid}  ${g.subject} (${g.size} members)\n`);
    } catch (err) {
      process.stdout.write(`\nCould not list groups: ${err.message}\n`);
    }
  }

  await provider.close();
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((err) => {
      // These are operator-facing conditions with a self-explanatory message;
      // a stack trace on top of them is just noise in the pm2 log.
      const EXPECTED = ['ECONFIG', 'ETIMEDOUT', 'ELOGGEDOUT', 'EUNLINKED', 'ECONNFAILED', 'EDEPMISSING', 'ENOTIMPLEMENTED'];
      if (err && EXPECTED.includes(err.code)) logger.error(err.message);
      else logger.error(err && err.stack ? err.stack : String(err));
      process.exit(1);
    });
}

module.exports = { main, parseArgv };
