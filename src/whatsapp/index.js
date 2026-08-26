'use strict';

const { createBaileysProvider } = require('./baileys');
const { createCloudProvider } = require('./cloud');
const { createDryRunProvider } = require('./dryrun');

/**
 * All transports share one interface:
 *   name, supportsGroups, supportsIncoming, isRegistered(), connect(),
 *   send(recipient, text), reply(incoming, text), onMessage(handler),
 *   listGroups(), whoami(), close()
 */
function createWhatsAppProvider(cfg) {
  if (cfg.provider === 'dry-run') return createDryRunProvider(null);

  const real = cfg.provider === 'cloud' ? createCloudProvider(cfg) : createBaileysProvider(cfg);
  return cfg.dryRun ? createDryRunProvider(real) : real;
}

module.exports = { createWhatsAppProvider };
