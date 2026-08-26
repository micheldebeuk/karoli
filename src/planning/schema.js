'use strict';

// The shape every planning source must produce. The Google Sheets reader (next
// milestone) only has to map the "Planes Karolito" columns onto these keys:
//
//   ID | Plan | Categoria | Tipo | Dia propuesto | Horario | Estado |
//   Voto Olivier | Voto Karina | Fecha del voto | Enlace oficial |
//   Google Maps | Notas
//
// ...which is exactly the FIELD_BY_COLUMN map below, so the mapping is not
// guesswork later on.

const FIELD_BY_COLUMN = {
  ID: 'id',
  Plan: 'plan',
  Categoria: 'categoria',
  Tipo: 'tipo',
  'Dia propuesto': 'dia',
  Horario: 'horario',
  Estado: 'estado',
  'Voto Olivier': 'votoOlivier',
  'Voto Karina': 'votoKarina',
  'Fecha del voto': 'fechaVoto',
  'Enlace oficial': 'enlace',
  'Google Maps': 'maps',
  Notas: 'notas',
};

const FIELDS = Object.values(FIELD_BY_COLUMN);

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

/**
 * "Sabado 29/08/2026" -> { date: Date, label: 'Sabado 29/08/2026' }.
 * Returns date:null when the cell has no parseable dd/mm/yyyy — the plan is
 * still kept and rendered, it just sorts last and never counts as "upcoming".
 */
function parseDia(raw) {
  const label = str(raw);
  const m = /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/.exec(label);
  if (!m) return { label, date: null };
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0); // midday: DST-proof
  if (Number.isNaN(date.getTime()) || date.getDate() !== day || date.getMonth() !== month - 1) {
    return { label, date: null };
  }
  return { label, date };
}

/** Column titles are matched loosely: case, accents and spacing vary in sheets. */
function columnKey(name) {
  return str(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const FIELD_BY_COLUMN_KEY = new Map(
  Object.entries(FIELD_BY_COLUMN).map(([column, field]) => [columnKey(column), field]),
);
// Field names map to themselves, so an already-normalised object round-trips.
for (const field of Object.values(FIELD_BY_COLUMN)) FIELD_BY_COLUMN_KEY.set(columnKey(field), field);

/**
 * Accepts either a row keyed by sheet column title ("Dia propuesto") or one
 * already keyed by field name ("dia"), so the Google Sheets reader can hand
 * rows straight over without a mapping step of its own.
 */
function toFields(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const field = FIELD_BY_COLUMN_KEY.get(columnKey(key));
    if (field && out[field] === undefined) out[field] = value;
  }
  return out;
}

/** [header, ...rows] straight from the Sheets API -> plan objects. */
function rowsToPlans(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const header = rows[0].map((h) => str(h));
  return rows
    .slice(1)
    .filter((row) => Array.isArray(row) && row.some((cell) => str(cell) !== ''))
    .map((row) => Object.fromEntries(header.map((name, i) => [name, row[i]])));
}

function normalizePlan(raw, index) {
  const source = toFields(raw);
  const plan = {};
  for (const field of FIELDS) plan[field] = str(source[field]);
  if (!plan.id) plan.id = `P${index + 1}`;
  const { label, date } = parseDia(plan.dia);
  plan.dia = label;
  plan.date = date;
  plan.dayLabel = date ? `${DAY_NAMES[date.getDay()]} ${label.replace(/^\D+/, '').trim()}` : label || 'Sin fecha';
  return plan;
}

function normalizePlanning(raw) {
  if (!raw || !Array.isArray(raw.plans)) {
    throw new Error('Planning source returned no `plans` array.');
  }
  return {
    title: str(raw.title) || 'Planes de Fin de Semana',
    source: str(raw.source),
    sheetId: str(raw.sheetId),
    plans: raw.plans.map(normalizePlan),
  };
}

/** Saturday 00:00 -> Sunday 23:59 of the weekend we are heading into. */
function upcomingWeekend(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const dow = start.getDay(); // 0=Sun .. 6=Sat
  // Sunday counts as "still this weekend", so step back to yesterday's Saturday.
  const offsetToSaturday = dow === 0 ? -1 : 6 - dow;
  const saturday = new Date(start);
  saturday.setDate(start.getDate() + offsetToSaturday);
  const end = new Date(saturday);
  end.setDate(saturday.getDate() + 1);
  end.setHours(23, 59, 59, 999);
  return { start: saturday, end };
}

function isUpcoming(plan, now = new Date()) {
  if (!plan.date) return false;
  const { start, end } = upcomingWeekend(now);
  return plan.date >= start && plan.date <= end;
}

/** Chronological, then by start time, then by ID — stable and readable. */
function sortPlans(plans) {
  return plans.slice().sort((a, b) => {
    if (a.date && b.date && a.date.getTime() !== b.date.getTime()) return a.date - b.date;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    if (a.horario !== b.horario) return a.horario.localeCompare(b.horario);
    return a.id.localeCompare(b.id);
  });
}

/** Group into [{ dayLabel, plans }] preserving chronological order. */
function groupByDay(plans) {
  const groups = [];
  const seen = new Map();
  for (const plan of sortPlans(plans)) {
    let group = seen.get(plan.dayLabel);
    if (!group) {
      group = { dayLabel: plan.dayLabel, date: plan.date, plans: [] };
      seen.set(plan.dayLabel, group);
      groups.push(group);
    }
    group.plans.push(plan);
  }
  return groups;
}

module.exports = {
  FIELD_BY_COLUMN,
  FIELDS,
  toFields,
  rowsToPlans,
  normalizePlan,
  normalizePlanning,
  parseDia,
  upcomingWeekend,
  isUpcoming,
  sortPlans,
  groupByDay,
};
