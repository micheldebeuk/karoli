// pm2 config for the Losali VPS. Mirrors how the losali proxy is run there, so
// `pm2 status` shows the planes bot next to it and `pm2 save` survives reboots.
//
//   cd /home/ubuntu/plans
//   pm2 start ecosystem.config.js && pm2 save
//
// Env comes from ./.env (loaded by src/config.js), not from here — nothing in
// this file is a secret.

const path = require('node:path');

const CWD = __dirname;
const COMMON = {
  cwd: CWD,
  interpreter: 'node',
  env: { NODE_ENV: 'production', TZ: 'Europe/Madrid' },
  merge_logs: true,
  time: true,
};

module.exports = {
  apps: [
    {
      // The always-on half: stays linked to WhatsApp and answers PLANES / votes.
      ...COMMON,
      name: 'planes-bot',
      script: path.join(CWD, 'src/index.js'),
      args: 'listen',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 10000,
      exp_backoff_restart_delay: 5000,
      max_memory_restart: '400M',
      out_file: path.join(CWD, 'logs/bot.out.log'),
      error_file: path.join(CWD, 'logs/bot.err.log'),
    },
    {
      // The scheduled half: one shot, Thursday 19:00 Europe/Madrid, then exits.
      // `autorestart: false` + `cron_restart` is pm2's way of running a job on a
      // schedule without a separate crontab entry.
      ...COMMON,
      name: 'planes-weekly',
      script: path.join(CWD, 'src/index.js'),
      args: 'send',
      autorestart: false,
      cron_restart: '0 19 * * 4',
      out_file: path.join(CWD, 'logs/weekly.out.log'),
      error_file: path.join(CWD, 'logs/weekly.err.log'),
    },
  ],
};
