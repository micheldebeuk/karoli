'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizePlanning } = require('../src/planning/schema');
const { renderPlanning, paginate, MAX_CHARS } = require('../src/format');

const NOW = new Date(2026, 7, 26, 10); // Wednesday before the 29-30 Aug weekend

function planning(plans) {
  return normalizePlanning({ title: 'Planes de Fin de Semana', plans });
}

test('renders one message with day headings and plan blocks', () => {
  const parts = renderPlanning(
    planning([
      { id: 'E1', plan: 'Caldetes', dia: 'Sabado 29/08/2026', horario: '09:30-14:00', categoria: 'Escapada - mar y playa', tipo: 'Con el peque', enlace: 'https://example.org' },
      { id: 'E3', plan: 'Montseny', dia: 'Domingo 30/08/2026', horario: '10:00-15:00', categoria: 'Escapada - naturaleza y bosque' },
    ]),
    { now: NOW },
  );

  assert.equal(parts.length, 1);
  assert.match(parts[0], /\*Planes de Fin de Semana\*/);
  assert.match(parts[0], /_Sábado 29 y domingo 30 de agosto_/);
  assert.match(parts[0], /\*SABADO 29\/08\/2026\*/);
  assert.match(parts[0], /\*E1 · Caldetes\*/);
  assert.match(parts[0], /https:\/\/example\.org/);
  assert.match(parts[0], /Vota respondiendo/);
});

test('drops plans outside the upcoming weekend', () => {
  const parts = renderPlanning(
    planning([
      { id: 'E1', plan: 'Este finde', dia: 'Sabado 29/08/2026' },
      { id: 'E9', plan: 'El finde que viene', dia: 'Sabado 05/09/2026' },
    ]),
    { now: NOW },
  );
  assert.match(parts[0], /Este finde/);
  assert.doesNotMatch(parts[0], /El finde que viene/);
});

test('falls back to the whole list rather than sending an empty planning', () => {
  const parts = renderPlanning(planning([{ id: 'E9', plan: 'Otro dia', dia: 'Sabado 05/09/2026' }]), { now: NOW });
  assert.match(parts[0], /Otro dia/);
  assert.match(parts[0], /Todos los planes propuestos/);
});

test('says so plainly when there is nothing proposed', () => {
  const parts = renderPlanning(planning([]), { now: NOW });
  assert.equal(parts.length, 1);
  assert.match(parts[0], /No hay planes propuestos/);
});

test('shows recorded votes when the sheet has them', () => {
  const parts = renderPlanning(
    planning([{ id: 'E1', plan: 'Caldetes', dia: 'Sabado 29/08/2026', votoOlivier: 'si', votoKarina: 'no' }]),
    { now: NOW },
  );
  assert.match(parts[0], /🗳️ Olivier ✅ · Karina ❌/);
});

test('splits into numbered parts instead of exceeding the message limit', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `E${i + 1}`,
    plan: `Plan numero ${i + 1}`,
    dia: 'Sabado 29/08/2026',
    horario: '10:00-12:00',
    notas: 'x'.repeat(200),
  }));
  const parts = renderPlanning(planning(many), { now: NOW });

  assert.ok(parts.length > 1, 'expected more than one part');
  for (const part of parts) assert.ok(part.length <= MAX_CHARS, `part too long: ${part.length}`);
  assert.match(parts[0], /_\(1\/\d+\)_$/);
  // Every plan must survive the split.
  const joined = parts.join('\n');
  for (const p of many) assert.match(joined, new RegExp(`\\*${p.id} · `));
});

test('paginate keeps a block whole and every part within the limit', () => {
  const block = 'y'.repeat(MAX_CHARS - 200);
  const parts = paginate('HEAD', [block, block], 'FOOT');

  assert.ok(parts.length >= 2, 'two near-limit blocks cannot share one message');
  for (const p of parts) assert.ok(p.length <= MAX_CHARS, `part too long: ${p.length}`);
  // Neither block was cut in half.
  assert.equal(parts.filter((p) => p.includes(block)).length, 2);
  assert.ok(parts.some((p) => p.includes('FOOT')));
});

test('paginate splits a block that cannot fit in any single message', () => {
  const monster = Array.from({ length: 200 }, (_, i) => `linea ${i} ${'z'.repeat(40)}`).join('\n');
  const parts = paginate('HEAD', [monster], 'FOOT');

  for (const p of parts) assert.ok(p.length <= MAX_CHARS, `part too long: ${p.length}`);
  // Nothing is lost, even though the block had to be cut.
  const joined = parts.join('\n');
  for (let i = 0; i < 200; i += 1) assert.ok(joined.includes(`linea ${i} `), `lost line ${i}`);
});
