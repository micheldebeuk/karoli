'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseDia,
  upcomingWeekend,
  isUpcoming,
  normalizePlanning,
  groupByDay,
  rowsToPlans,
} = require('../src/planning/schema');

test('parses the sheet\'s "Dia propuesto" cells', () => {
  const { date, label } = parseDia('Sabado 29/08/2026');
  assert.equal(label, 'Sabado 29/08/2026');
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 7); // August
  assert.equal(date.getDate(), 29);
});

test('keeps undated rows instead of dropping them', () => {
  assert.deepEqual(parseDia('Cuando podamos'), { label: 'Cuando podamos', date: null });
  assert.deepEqual(parseDia(''), { label: '', date: null });
  assert.equal(parseDia('32/13/2026').date, null);
});

test('the upcoming weekend runs Saturday to Sunday', () => {
  // Wednesday 26 Aug 2026 -> Sat 29 / Sun 30.
  const { start, end } = upcomingWeekend(new Date(2026, 7, 26, 10));
  assert.equal(start.getDate(), 29);
  assert.equal(end.getDate(), 30);
});

test('on a Sunday the weekend in progress still counts', () => {
  const { start, end } = upcomingWeekend(new Date(2026, 7, 30, 10));
  assert.equal(start.getDate(), 29);
  assert.equal(end.getDate(), 30);
});

test('isUpcoming filters on that window', () => {
  const now = new Date(2026, 7, 26, 10);
  const planning = normalizePlanning({
    plans: [
      { ID: 'A1', Plan: 'Este finde', 'Dia propuesto': 'Sabado 29/08/2026' },
      { ID: 'A2', Plan: 'El que viene', 'Dia propuesto': 'Sabado 05/09/2026' },
      { ID: 'A3', Plan: 'Sin fecha', 'Dia propuesto': '' },
    ],
  });
  assert.deepEqual(planning.plans.filter((p) => isUpcoming(p, now)).map((p) => p.id), ['A1']);
});

test('normalizePlanning maps sheet columns and fills missing ids', () => {
  const planning = normalizePlanning({
    plans: [{ Plan: 'Sin id', 'Dia propuesto': 'Domingo 30/08/2026', Notas: ' con espacios ' }],
  });
  assert.equal(planning.plans[0].id, 'P1');
  assert.equal(planning.plans[0].notas, 'con espacios');
  assert.equal(planning.title, 'Planes de Fin de Semana');
});

test('normalizePlanning refuses a source that returned nothing usable', () => {
  assert.throws(() => normalizePlanning(null), /no `plans` array/);
  assert.throws(() => normalizePlanning({}), /no `plans` array/);
});

test('groupByDay orders days chronologically and plans by start time', () => {
  const planning = normalizePlanning({
    plans: [
      { ID: 'B1', 'Dia propuesto': 'Domingo 30/08/2026', Horario: '10:00-15:00' },
      { ID: 'B2', 'Dia propuesto': 'Sabado 29/08/2026', Horario: '17:00-19:30' },
      { ID: 'B3', 'Dia propuesto': 'Sabado 29/08/2026', Horario: '09:30-14:00' },
    ],
  });
  const groups = groupByDay(planning.plans);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].plans.map((p) => p.id), ['B3', 'B2']);
  assert.deepEqual(groups[1].plans.map((p) => p.id), ['B1']);
});

test('rowsToPlans turns a raw Sheets values array into plan rows', () => {
  const values = [
    ['ID', 'Plan', 'Dia propuesto', 'Horario', 'Notas'],
    ['E1', 'Caldetes', 'Sabado 29/08/2026', '09:30-14:00', 'R1 desde Arc de Triomf'],
    ['', '', '', '', ''], // blank rows are common at the bottom of a sheet
    ['C1', 'Festa Major', 'Sabado 29/08/2026', '17:30-20:30', 'Gratis'],
  ];
  const planning = normalizePlanning({ plans: rowsToPlans(values) });
  assert.deepEqual(planning.plans.map((p) => p.id), ['E1', 'C1']);
  assert.equal(planning.plans[0].horario, '09:30-14:00');
  assert.equal(planning.plans[0].date.getDate(), 29);
});

test('rowsToPlans tolerates a sheet with only a header', () => {
  assert.deepEqual(rowsToPlans([['ID', 'Plan']]), []);
  assert.deepEqual(rowsToPlans([]), []);
});
