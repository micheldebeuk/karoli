'use strict';

// The console page (console/planes-console.html) re-implements the message
// formatter in the browser so it can preview what the bot will send. That
// preview is only worth anything if it stays identical to src/format.js — so
// these tests run the page's REAL script, extracted from the HTML under a DOM
// stub, and diff its output against the app's own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(APP, 'console/planes-console.html'), 'utf8');

// --- minimal DOM so the page's boot code can run unchanged ----------------
const el = () => new Proxy({}, {
  get(t, k) {
    if (k === 'querySelectorAll') return () => [];
    if (k === 'addEventListener') return () => {};
    if (k === 'setAttribute') return () => {};
    if (k === 'appendChild' || k === 'remove' || k === 'select') return () => {};
    if (k === 'classList') return { add() {}, remove() {} };
    if (k === 'dataset') return {};
    if (k === 'style') return { cssText: '' };
    if (k === 'value') return '';
    return t[k];
  },
  set(t, k, v) { t[k] = v; return true; },
});

globalThis.document = {
  getElementById: el,
  querySelectorAll: () => [],
  createElement: el,
  body: el(),
  execCommand: () => true,
};
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
globalThis.window = globalThis;
globalThis.claude = { use: async () => null };

// --- extract the IIFE and make it hand back its internals ------------------
const src = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const opened = src.slice(0, src.lastIndexOf('})();'));
const api = eval(opened + '\n return { parseSheet, buildMessage, toHtml, normalizePlan };\n})()');

// --- the app's own implementation -----------------------------------------
const { normalizePlanning } = require(path.join(APP, 'src/planning/schema'));
const { renderPlanning } = require(path.join(APP, 'src/format'));
const fixture = JSON.parse(fs.readFileSync(path.join(APP, 'fixtures/planning.json'), 'utf8'));

// A verbatim slice of what Google Drive actually returned for this sheet.
// Note the shape: a blank row, an alignment row, THEN the real header.
const REAL_EXCERPT = [
  '|  |  |  |  |  |  |  |  |  |  |  |  |  |',
  '| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |',
  '| ID | Plan | Categoria | Tipo | Dia propuesto | Horario | Estado | Voto Olivier | Voto Karina | Fecha del voto | Enlace oficial | Google Maps | Notas |',
  "| E1 | Caldes d'Estrac (Caldetes) | Escapada - mar y playa | Con el peque | Sabado 29/08/2026 | 09:30-14:00 | todo |  |  |  | https://caldetes.cat/turisme | https://www.google.com/maps/search/?api=1\\&query=Platja+dels+Tres+Micos+Caldes+d'Estrac | R1 desde Arc de Triomf 50-55 min. Fundacio Palau al lado. Carrito OK. |",
  '| C3 | Jean-Luc Godard - La Virreina | Cultura - exposicion | CANGURO (solo adultos) | Sabado 29/08/2026 | 17:00-19:30 | todo |  |  |  | https://ajuntament.barcelona.cat/lavirreina/ca/exposicions | https://www.google.com/maps/search/?api=1\\&query=Palau+de+la+Virreina+La+Rambla+99+Barcelona | Gratis sin reserva. Mayor retrospectiva Godard del mundo. Hasta el 4 de octubre. |',
].join('\n');

test('parses the table shape Google Drive actually returns', () => {
  const parsed = api.parseSheet(REAL_EXCERPT);

  // The header is not row 0 — a blank row and an alignment row sit above it.
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'E1');
  assert.equal(parsed[0].plan, "Caldes d'Estrac (Caldetes)");
  assert.equal(parsed[0].horario, '09:30-14:00');
  assert.equal(parsed[0].tipo, 'Con el peque');
  assert.equal(parsed[0].date.getDate(), 29);
  assert.equal(parsed[0].dayLabel, 'Sabado 29/08/2026');
  assert.equal(parsed[1].tipo, 'CANGURO (solo adultos)');
});

test('undoes the backslash escapes Drive puts in cells', () => {
  // Left in place, every Google Maps link in the message would be broken.
  const parsed = api.parseSheet(REAL_EXCERPT);
  assert.equal(
    parsed[0].maps,
    "https://www.google.com/maps/search/?api=1&query=Platja+dels+Tres+Micos+Caldes+d'Estrac",
  );
});

const COLS = ['ID','Plan','Categoria','Tipo','Dia propuesto','Horario','Estado',
  'Voto Olivier','Voto Karina','Fecha del voto','Enlace oficial','Google Maps','Notas'];
const FIELDS = ['id','plan','categoria','tipo','dia','horario','estado',
  'votoOlivier','votoKarina','fechaVoto','enlace','maps','notas'];

const table = [
  '|' + COLS.map(() => '  ').join('|') + '|',
  '|' + COLS.map(() => ' :-: ').join('|') + '|',
  '| ' + COLS.join(' | ') + ' |',
  ...fixture.plans.map((p) =>
    '| ' + FIELDS.map((f) => String(p[f] ?? '').replace(/&/g, '\\&')).join(' | ') + ' |'),
].join('\n');

const NOW = new Date(2026, 7, 26, 10);

test('the preview is byte-for-byte what the bot would send', () => {
  const consolePlans = api.parseSheet(table);
  assert.equal(consolePlans.length, fixture.plans.length);

  assert.deepStrictEqual(
    api.buildMessage(consolePlans, true, NOW).parts,
    renderPlanning(normalizePlanning(fixture), { now: NOW, upcomingOnly: true }),
  );
});

test('the "Todos" toggle matches the CLI\'s --all', () => {
  assert.deepStrictEqual(
    api.buildMessage(api.parseSheet(table), false, NOW).parts,
    renderPlanning(normalizePlanning(fixture), { now: NOW, upcomingOnly: false }),
  );
});

test('excluding plans in the console tracks the bot for that subset', () => {
  const drop = ['E2', 'C1'];
  const subset = api.parseSheet(table).filter((p) => !drop.includes(p.id));

  assert.deepStrictEqual(
    api.buildMessage(subset, true, NOW).parts,
    renderPlanning(
      normalizePlanning({ plans: fixture.plans.filter((p) => !drop.includes(p.id)) }),
      { now: NOW, upcomingOnly: true },
    ),
  );
});

const many = Array.from({ length: 40 }, (_, i) => ({
  id: 'E' + (i + 1), plan: 'Plan numero ' + (i + 1), categoria: 'Cultura - exposicion',
  tipo: 'Con el peque', dia: 'Sabado 29/08/2026', horario: '10:00-12:00',
  estado: 'todo', votoOlivier: '', votoKarina: '', fechaVoto: '',
  enlace: '', maps: '', notas: 'x'.repeat(200),
}));
const bigTable = [
  '|' + COLS.map(() => '  ').join('|') + '|',
  '|' + COLS.map(() => ' :-: ').join('|') + '|',
  '| ' + COLS.join(' | ') + ' |',
  ...many.map((p) => '| ' + FIELDS.map((f) => String(p[f] ?? '')).join(' | ') + ' |'),
].join('\n');
test('pagination agrees with the bot on a planning that must split', () => {
  const bigApp = renderPlanning(normalizePlanning({ plans: many }), { now: NOW, upcomingOnly: true });
  assert.ok(bigApp.length > 1, 'this fixture is meant to split');
  assert.deepStrictEqual(api.buildMessage(api.parseSheet(bigTable), true, NOW).parts, bigApp);
});

test('WhatsApp markdown renders, but never inside a URL', () => {
  const h = api.toHtml('*Planes* y https://example.org/a_b_c y _cursiva_');
  assert.match(h, /<strong>Planes<\/strong>/);
  assert.match(h, /<em>cursiva<\/em>/);
  assert.match(h, /href="https:\/\/example\.org\/a_b_c"/);
  // An underscore in a link must not italicise half the URL.
  assert.doesNotMatch(h, /example\.org\/a<em>b<\/em>c/);
});

test('sheet content cannot inject HTML into the preview', () => {
  const h = api.toHtml('<img src=x onerror=alert(1)> *ok*');
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
  assert.match(h, /<strong>ok<\/strong>/);
});
