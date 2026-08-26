'use strict';

const { groupByDay, isUpcoming, upcomingWeekend } = require('./planning/schema');

// WhatsApp accepts long bodies, but anything past a few thousand characters is
// unreadable on a phone and risks silent truncation by some clients. Split into
// numbered parts instead.
const MAX_CHARS = 3500;

const MONTHS = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function tipoIcon(tipo) {
  const t = tipo.toLowerCase();
  if (t.includes('canguro') || t.includes('adulto')) return '🍸';
  if (t.includes('peque')) return '👶';
  return '•';
}

function categoriaIcon(categoria) {
  const c = categoria.toLowerCase();
  if (c.includes('mar') || c.includes('playa')) return '🏖️';
  if (c.includes('naturaleza') || c.includes('bosque')) return '🌲';
  if (c.includes('pueblo')) return '🏘️';
  if (c.includes('festa') || c.includes('fiesta')) return '🎉';
  if (c.includes('exposicion') || c.includes('cultura')) return '🎨';
  return '📌';
}

function voteMark(value) {
  const v = value.trim().toLowerCase();
  if (!v) return '—';
  if (/^(si|sí|s|yes|y|1|ok)$/.test(v)) return '✅';
  if (/^(no|n|0)$/.test(v)) return '❌';
  return value.trim();
}

function weekendSubtitle(now = new Date()) {
  const { start, end } = upcomingWeekend(now);
  const sameMonth = start.getMonth() === end.getMonth();
  const left = `${start.getDate()}${sameMonth ? '' : ` de ${MONTHS[start.getMonth()]}`}`;
  return `Sábado ${left} y domingo ${end.getDate()} de ${MONTHS[end.getMonth()]}`;
}

/** One plan as a WhatsApp block. */
function renderPlan(plan) {
  const lines = [];
  lines.push(`${categoriaIcon(plan.categoria)} *${plan.id} · ${plan.plan}*`);

  const meta = [plan.horario, plan.categoria].filter(Boolean).join(' · ');
  if (meta) lines.push(`🕒 ${meta}`);
  if (plan.tipo) lines.push(`${tipoIcon(plan.tipo)} ${plan.tipo}`);
  if (plan.notas) lines.push(`📝 ${plan.notas}`);

  const votes = [];
  if (plan.votoOlivier || plan.votoKarina) {
    votes.push(`Olivier ${voteMark(plan.votoOlivier)}`, `Karina ${voteMark(plan.votoKarina)}`);
  }
  if (votes.length) lines.push(`🗳️ ${votes.join(' · ')}`);

  if (plan.enlace) lines.push(`🔗 ${plan.enlace}`);
  if (plan.maps) lines.push(`📍 ${plan.maps}`);

  return lines.join('\n');
}

/**
 * Render the planning into one or more WhatsApp message bodies.
 * @returns {string[]} message parts, already numbered when there is more than one.
 */
function renderPlanning(planning, options = {}) {
  const now = options.now || new Date();
  const upcomingOnly = options.upcomingOnly !== false;

  let plans = planning.plans;
  let filtered = false;
  if (upcomingOnly) {
    const subset = plans.filter((p) => isUpcoming(p, now));
    // Never send an empty message just because the sheet is ahead of or behind
    // the current weekend — fall back to the whole list and say so.
    if (subset.length) {
      plans = subset;
      filtered = true;
    }
  }

  const header = [`*${planning.title}*`, `_${filtered ? weekendSubtitle(now) : 'Todos los planes propuestos'}_`];

  if (plans.length === 0) {
    return [`${header.join('\n')}\n\nNo hay planes propuestos todavía. 🤷`];
  }

  const blocks = [];
  for (const group of groupByDay(plans)) {
    blocks.push(`*${group.dayLabel.toUpperCase()}*`);
    for (const plan of group.plans) blocks.push(renderPlan(plan));
  }

  const footer =
    '➡️ Vota respondiendo *E1 SI* o *C2 NO*.\n' +
    'Escribe *PLANES* para ver la lista otra vez, *AYUDA* para los comandos.';

  return paginate(header.join('\n'), blocks, footer);
}

/**
 * Pack blocks into as few messages as possible without splitting a block.
 *
 * Parts get a "_(1/3)_" suffix when there is more than one, so the packing
 * budget reserves room for it up front — appending it afterwards is how a part
 * ends up one character over the limit.
 */
const SUFFIX_BUDGET = 16; // "\n\n_(99/99)_" and change

function paginate(header, blocks, footer) {
  const budget = MAX_CHARS - SUFFIX_BUDGET;
  const parts = [];
  let current = header;

  const flush = () => {
    if (current !== header) {
      parts.push(current);
      current = header;
    }
  };

  for (const block of blocks) {
    for (const piece of splitOversized(block, budget - header.length - 2)) {
      const candidate = `${current}\n\n${piece}`;
      if (candidate.length > budget && current !== header) {
        flush();
        current = `${header}\n\n${piece}`;
      } else {
        current = candidate;
      }
    }
  }

  const withFooter = `${current}\n\n${footer}`;
  if (withFooter.length <= budget) {
    parts.push(withFooter);
  } else {
    flush();
    parts.push(`${header}\n\n${footer}`);
  }

  if (parts.length === 1) return parts;
  return parts.map((p, i) => `${p}\n\n_(${i + 1}/${parts.length})_`);
}

/**
 * Last resort for a block that cannot fit in any message on its own (a plan
 * with a huge Notas cell). Split on line boundaries, and only mid-line when a
 * single line is itself too long.
 */
function splitOversized(block, limit) {
  if (block.length <= limit) return [block];

  const pieces = [];
  let current = '';
  for (const line of block.split('\n')) {
    for (const chunk of hardChunk(line, limit)) {
      const candidate = current ? `${current}\n${chunk}` : chunk;
      if (candidate.length > limit && current) {
        pieces.push(current);
        current = chunk;
      } else {
        current = candidate;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function hardChunk(line, limit) {
  if (line.length <= limit) return [line];
  const out = [];
  for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
  return out;
}

module.exports = { renderPlanning, renderPlan, paginate, weekendSubtitle, MAX_CHARS };
