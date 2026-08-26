// Consola Karolito — browser half.
//
// It deliberately does NOT format messages. The bot renders them with its own
// src/format.js and returns the finished parts, so what is previewed here is
// exactly what WhatsApp receives, with no second implementation to drift.

const $ = (id) => document.getElementById(id);
const HEADERS = { 'content-type': 'application/json', 'x-planes-console': '1' };

const state = {
  plans: [],
  parts: [],
  excluded: new Set(),
  upcomingOnly: true,
  status: null,
  busy: false,
};

// ---------------------------------------------------------------- helpers
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try { payload = await res.json(); } catch { /* keep the status */ }
  if (res.status === 401 && path !== '/api/login') {
    showGate('La sesión ha caducado. Entra otra vez.');
    throw Object.assign(new Error('unauthorized'), { handled: true });
  }
  return { status: res.status, ok: res.ok, payload };
}

// WhatsApp markdown -> HTML, formatting only outside URLs so an underscore in
// a link cannot italicise half of it.
const URL_RE = /(https?:\/\/[^\s]+)/g;
function fmt(text) {
  let h = esc(text);
  h = h.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=[\s.,;:!?)]|$)/g, '$1<strong>$2</strong>');
  h = h.replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>');
  h = h.replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=[\s.,;:!?)]|$)/g, '$1<s>$2</s>');
  return h;
}
function toHtml(text) {
  let out = '';
  let last = 0;
  for (const m of String(text).matchAll(URL_RE)) {
    out += fmt(text.slice(last, m.index));
    out += `<a href="${esc(m[0])}" target="_blank" rel="noopener noreferrer">${esc(m[0])}</a>`;
    last = m.index + m[0].length;
  }
  return out + fmt(text.slice(last));
}

function voteMark(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '—';
  if (/^(si|sí|s|yes|y|1|ok)$/.test(s)) return '✅';
  if (/^(no|n|0)$/.test(s)) return '❌';
  return String(v).trim();
}

// ------------------------------------------------------------------ views
function showGate(message) {
  $('console').hidden = true;
  $('gate').hidden = false;
  const err = $('loginErr');
  if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
  $('password').focus();
}

function showConsole() {
  $('gate').hidden = true;
  $('console').hidden = false;
}

function banner(message) {
  const el = $('banner');
  if (!message) return void (el.hidden = true);
  el.textContent = message;
  el.hidden = false;
}

// ----------------------------------------------------------------- render
function renderStatus() {
  const s = state.status;
  const linked = s ? (s.linked ? ['live', 'vinculado'] : ['bad', 'sin vincular']) : ['wait', 'cargando…'];
  const cells = [
    ['WhatsApp', `<span class="dot ${linked[0]}"></span>${esc(linked[1])}`],
    ['Transporte', esc(s ? s.provider : '—')],
    ['Origen', esc(s ? s.source : '—')],
    ['Destinatarios', s ? String(s.recipients.length) : '—'],
  ];
  $('status').innerHTML = cells
    .map(([k, v]) => `<div class="cell"><div class="k">${k}</div><div class="v">${v}</div></div>`)
    .join('');
}

function groupByDay(plans) {
  const groups = [];
  const seen = new Map();
  const sorted = plans.slice().sort((a, b) => {
    const ad = a.date ? Date.parse(a.date) : Infinity;
    const bd = b.date ? Date.parse(b.date) : Infinity;
    if (ad !== bd) return ad - bd;
    return String(a.horario).localeCompare(String(b.horario)) || a.id.localeCompare(b.id);
  });
  for (const p of sorted) {
    let g = seen.get(p.dayLabel);
    if (!g) { g = { dayLabel: p.dayLabel, plans: [] }; seen.set(p.dayLabel, g); groups.push(g); }
    g.plans.push(p);
  }
  return groups;
}

function renderLedger() {
  const el = $('ledger');
  if (!state.plans.length) {
    el.innerHTML = '<div class="empty"><h3>Sin planes</h3><p>El bot no devolvió ninguna fila. Revisa su origen de datos.</p></div>';
    $('planCount').textContent = '';
    return;
  }

  let html = '';
  for (const g of groupByDay(state.plans)) {
    html += `<div class="day"><span class="t">${esc(g.dayLabel)}</span></div>`;
    for (const p of g.plans) {
      const on = !state.excluded.has(p.id);
      const canguro = /canguro|adulto/i.test(p.tipo || '');
      html += `<div class="plan${on ? '' : ' out'}">` +
        `<input type="checkbox" ${on ? 'checked' : ''} data-id="${esc(p.id)}" aria-label="Incluir ${esc(p.id)}">` +
        `<div><div class="name"><span class="id">${esc(p.id)}</span> · ${esc(p.plan)}</div>` +
        `<div class="meta">${esc(p.categoria || '')}</div>` +
        (p.notas ? `<div class="notes">${esc(p.notas)}</div>` : '') + '</div>' +
        '<div class="right">' +
          (p.horario ? `<span class="chip time">${esc(p.horario)}</span>` : '') +
          (p.tipo ? `<span class="chip${canguro ? ' canguro' : ''}">${esc(p.tipo)}</span>` : '') +
          `<span class="votes">O ${voteMark(p.votoOlivier)} · K ${voteMark(p.votoKarina)}</span>` +
        '</div></div>';
    }
  }
  el.innerHTML = html;
  el.querySelectorAll('input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', () => {
      if (box.checked) state.excluded.delete(box.dataset.id);
      else state.excluded.add(box.dataset.id);
      renderLedger();
      refreshPreview();
    });
  });

  const included = state.plans.length - state.excluded.size;
  $('planCount').textContent = `${included} de ${state.plans.length} incluidos`;
}

function renderMessage() {
  const parts = state.parts;
  $('msgParts').innerHTML = parts.length
    ? parts.map((p, i) =>
        '<div class="msg">' +
        (parts.length > 1 ? `<span class="part-tag">mensaje ${i + 1} de ${parts.length}</span>` : '') +
        toHtml(p) + '</div>').join('')
    : '<div class="msg">—</div>';

  const total = parts.reduce((n, p) => n + p.length, 0);
  const longest = parts.reduce((n, p) => Math.max(n, p.length), 0);
  $('meter').innerHTML =
    `<span>caracteres <b>${total}</b></span><span>mensajes <b>${parts.length}</b></span>` +
    `<span>más largo <b>${longest}</b></span>`;
  $('msgNote').textContent = parts.length > 1 ? `se envía en ${parts.length} partes` : 'cabe en un mensaje';

  const recipients = state.status ? state.status.recipients : [];
  $('sendLede').textContent = recipients.length
    ? `Se enviará a ${recipients.join(', ')}.`
    : 'No hay destinatarios configurados en el bot.';
}

function renderHistory() {
  const rows = (state.status && state.status.history) || [];
  $('history').innerHTML = rows.length
    ? rows.map((h) => {
        const when = new Date(h.at).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        const what = `${h.delivered}/${h.delivered + h.failed} · ${h.parts} parte${h.parts > 1 ? 's' : ''}${h.dryRun ? ' · en seco' : ''}`;
        return `<div class="hrow"><time>${esc(when)}</time><span class="what">${esc(what)}</span></div>`;
      }).join('')
    : '<div class="empty"><p>Todavía nada desde el último reinicio del bot.</p></div>';
}

// ------------------------------------------------------------------ data
async function refreshPreview() {
  const { ok, payload } = await api('/api/preview', {
    method: 'POST',
    body: { exclude: [...state.excluded], upcomingOnly: state.upcomingOnly },
  });
  if (!ok) return banner(payload.message || 'No se pudo recalcular el mensaje.');
  banner('');
  state.parts = payload.parts || [];
  renderMessage();
}

async function loadAll() {
  const [status, planning] = await Promise.all([api('/api/status'), api('/api/planning')]);

  if (!status.ok) {
    banner(status.payload.message || 'El bot no responde.');
    renderStatus();
    return;
  }
  state.status = status.payload;
  banner(state.status.planningError || '');

  if (planning.ok) {
    state.plans = planning.payload.plans || [];
    state.parts = planning.payload.parts || [];
    state.upcomingOnly = Boolean(planning.payload.upcomingOnly);
    setWeekendButtons();
  }

  renderStatus();
  renderLedger();
  renderMessage();
  renderHistory();
}

// -------------------------------------------------------------- controls
function setWeekendButtons() {
  $('segWeekend').setAttribute('aria-pressed', String(state.upcomingOnly));
  $('segAll').setAttribute('aria-pressed', String(!state.upcomingOnly));
}
function setWeekend(upcomingOnly) {
  state.upcomingOnly = upcomingOnly;
  setWeekendButtons();
  refreshPreview();
}
$('segWeekend').addEventListener('click', () => setWeekend(true));
$('segAll').addEventListener('click', () => setWeekend(false));

function outcome(kind, html) {
  const el = $('outcome');
  el.className = `outcome ${kind}`;
  el.innerHTML = html;
  el.hidden = false;
}

function setBusy(busy) {
  state.busy = busy;
  $('dryBtn').disabled = busy;
  $('sendBtn').disabled = busy;
}

async function doSend({ dryRun }) {
  setBusy(true);
  outcome('', dryRun ? 'Probando en seco…' : 'Enviando…');
  try {
    const { status, ok, payload } = await api('/api/send', {
      method: 'POST',
      body: {
        dryRun,
        confirm: dryRun ? undefined : 'ENVIAR',
        exclude: [...state.excluded],
        upcomingOnly: state.upcomingOnly,
      },
    });

    if (!ok && status !== 207) {
      return outcome('bad', esc(payload.message || 'El envío falló.'));
    }

    const failed = (payload.results || []).filter((r) => !r.ok);
    const head = dryRun
      ? `Prueba en seco: ${payload.delivered} destinatario(s), ${payload.parts} parte(s). No se envió nada.`
      : `Enviado a ${payload.delivered} de ${payload.delivered + payload.failed} destinatario(s), ${payload.parts} parte(s).`;

    outcome(failed.length ? 'warn' : 'ok', esc(head) +
      (failed.length
        ? '<ul>' + failed.map((f) => `<li>${esc(f.recipient)}: ${esc(f.error)}</li>`).join('') + '</ul>'
        : ''));

    if (!dryRun) {
      toast(failed.length ? 'Enviado con incidencias' : 'Enviado');
      const status2 = await api('/api/status');
      if (status2.ok) { state.status = status2.payload; renderHistory(); }
    }
  } catch (err) {
    if (!err.handled) outcome('bad', 'No se pudo contactar con la consola.');
  } finally {
    setBusy(false);
  }
}

$('dryBtn').addEventListener('click', () => doSend({ dryRun: true }));

// A real send is two deliberate clicks: WhatsApp messages cannot be unsent.
let armed = false;
let armTimer;
function disarm() {
  armed = false;
  clearTimeout(armTimer);
  $('sendBtn').textContent = 'Enviar por WhatsApp';
  $('sendBtn').classList.remove('arming');
}
$('sendBtn').addEventListener('click', () => {
  if (state.busy) return;
  if (!armed) {
    armed = true;
    $('sendBtn').textContent = 'Confirmar envío';
    $('sendBtn').classList.add('arming');
    armTimer = setTimeout(disarm, 6000);
    return;
  }
  disarm();
  doSend({ dryRun: false });
});

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/login', { method: 'DELETE', headers: HEADERS });
  location.reload();
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  try {
    const { ok, payload } = await api('/api/login', {
      method: 'POST',
      body: { password: $('password').value },
    });
    if (!ok) {
      const err = $('loginErr');
      err.textContent = payload.message || 'No se pudo entrar.';
      err.hidden = false;
      return;
    }
    $('password').value = '';
    showConsole();
    await loadAll();
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ boot
(async () => {
  const { payload } = await api('/api/login');
  if (payload && payload.authenticated) {
    showConsole();
    await loadAll();
  } else {
    showGate();
  }
})();
