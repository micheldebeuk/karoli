'use strict';

const fs = require('node:fs');
const { normalizePlanning } = require('./schema');

/**
 * A planning source is `{ name, load(): Promise<Planning>, recordVote?(...) }`.
 * Everything downstream (formatting, sending, the bot commands) works against
 * this interface only, so swapping the fixture for the live sheet is a one-file
 * change with no ripples.
 */

function fixtureSource(cfg) {
  return {
    name: 'fixture',
    writable: false,
    async load() {
      if (!fs.existsSync(cfg.planning.fixtureFile)) {
        throw new Error(`Planning fixture not found: ${cfg.planning.fixtureFile}`);
      }
      const raw = JSON.parse(fs.readFileSync(cfg.planning.fixtureFile, 'utf8'));
      return normalizePlanning(raw);
    },
    async recordVote() {
      throw Object.assign(
        new Error(
          'Votes cannot be saved yet: the planning is read from a static fixture. ' +
            'Wire up PLANNING_SOURCE=google-sheets to make voting write back to the sheet.',
        ),
        { code: 'ENOTIMPLEMENTED' },
      );
    },
  };
}

function googleSheetsSource(cfg) {
  // ---------------------------------------------------------------------
  // NOT IMPLEMENTED YET — this is the Google half of the project.
  //
  // What it has to do:
  //   1. Authenticate to Google (service account JSON, or an OAuth refresh
  //      token for the account that owns the sheet). The sheet must be shared
  //      with the service account e-mail if that route is taken.
  //   2. GET spreadsheets/{PLANNING_SHEET_ID}/values/{PLANNING_SHEET_RANGE}.
  //   3. Hand the raw `values` array to schema.rowsToPlans(values) and the
  //      result to normalizePlanning({ plans }) — the column-title mapping and
  //      date parsing are already done there.
  //   4. For recordVote(): write the "Voto Olivier" / "Voto Karina" and
  //      "Fecha del voto" cells of the matching ID row back to the sheet.
  //
  // Everything after step 4 (formatting + delivery) is already done.
  // ---------------------------------------------------------------------
  return {
    name: 'google-sheets',
    writable: true,
    async load() {
      throw Object.assign(
        new Error(
          'PLANNING_SOURCE=google-sheets is not implemented yet. ' +
            `Sheet ${cfg.planning.sheetId || '(unset)'} range ${cfg.planning.sheetRange}. ` +
            'Use PLANNING_SOURCE=fixture until the Google reader lands.',
        ),
        { code: 'ENOTIMPLEMENTED' },
      );
    },
    async recordVote() {
      throw Object.assign(new Error('google-sheets source is not implemented yet.'), {
        code: 'ENOTIMPLEMENTED',
      });
    },
  };
}

function createPlanningSource(cfg) {
  switch (cfg.planning.source) {
    case 'fixture':
      return fixtureSource(cfg);
    case 'google-sheets':
      return googleSheetsSource(cfg);
    default:
      throw new Error(`Unknown PLANNING_SOURCE "${cfg.planning.source}"`);
  }
}

module.exports = { createPlanningSource };
