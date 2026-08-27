'use strict';

const fs = require('node:fs');
const path = require('node:path');
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

/**
 * Route B: the planning is pushed in by a scheduled Claude Routine that reads
 * the Google Sheet with the operator's own Drive connector and POSTs the rows
 * to /api/planning/import. Nothing Google-specific runs on the VPS — no service
 * account, no OAuth client, no credentials on the box.
 *
 * The cache is a plain file so a bot restart does not lose the last planning.
 */
function pushedSource(cfg) {
  return {
    name: 'pushed',
    writable: false,
    async load() {
      if (!fs.existsSync(cfg.planning.pushedFile)) {
        throw Object.assign(
          new Error(
            'No planning has been pushed yet. The Routine posts it to /api/planning/import; ' +
              'see console/README.md, or switch to PLANNING_SOURCE=fixture.',
          ),
          { code: 'ENOPLANNING' },
        );
      }
      const raw = JSON.parse(fs.readFileSync(cfg.planning.pushedFile, 'utf8'));
      const planning = normalizePlanning(raw);
      planning.pushedAt = raw.pushedAt || null;
      return planning;
    },
    /** Replace the cached planning. Returns the normalised result. */
    save(raw) {
      const planning = normalizePlanning(raw);
      const payload = {
        title: planning.title,
        source: planning.source || 'pushed by Routine',
        sheetId: planning.sheetId || cfg.planning.sheetId,
        pushedAt: new Date().toISOString(),
        plans: planning.plans.map((p) => ({
          id: p.id, plan: p.plan, categoria: p.categoria, tipo: p.tipo, dia: p.dia,
          horario: p.horario, estado: p.estado, votoOlivier: p.votoOlivier,
          votoKarina: p.votoKarina, fechaVoto: p.fechaVoto, enlace: p.enlace,
          maps: p.maps, notas: p.notas,
        })),
      };
      fs.mkdirSync(path.dirname(cfg.planning.pushedFile), { recursive: true, mode: 0o700 });
      const tmp = `${cfg.planning.pushedFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, cfg.planning.pushedFile); // atomic: never a half-written planning
      return { ...planning, pushedAt: payload.pushedAt };
    },
    async recordVote() {
      throw Object.assign(
        new Error(
          'Votes are not written back yet. The Routine that pushes the planning would also have to ' +
            'write the vote columns to the sheet.',
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
    case 'pushed':
      return pushedSource(cfg);
    case 'google-sheets':
      return googleSheetsSource(cfg);
    default:
      throw new Error(`Unknown PLANNING_SOURCE "${cfg.planning.source}"`);
  }
}

module.exports = { createPlanningSource };
