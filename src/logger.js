'use strict';

// Tiny structured-ish logger. Also exposes `pinoCompatible()` because Baileys
// expects a pino instance (it calls `logger.child(...)` internally) and pulling
// pino in just for that would be a dependency for nothing.

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: 70 };

function levelFromEnv() {
  const raw = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] === undefined ? LEVELS.info : LEVELS[raw];
}

let threshold = levelFromEnv();

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const stamp = new Date().toISOString();
  const text = args
    .map((a) => (typeof a === 'string' ? a : safeInspect(a)))
    .join(' ');
  stream.write(`${stamp} ${level.toUpperCase().padEnd(5)} ${text}\n`);
}

function safeInspect(value) {
  try {
    if (value instanceof Error) return value.stack || value.message;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const logger = {
  setLevel(name) {
    if (LEVELS[name] !== undefined) threshold = LEVELS[name];
  },
  trace: (...a) => emit('trace', a),
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  fatal: (...a) => emit('fatal', a),
};

// Baileys is extremely chatty at debug/trace and expects a pino-shaped logger.
// Default it to `silent` unless BAILEYS_LOG_LEVEL says otherwise, so the useful
// output (QR, pairing code, send results) is not buried.
function pinoCompatible() {
  const name = String(process.env.BAILEYS_LOG_LEVEL || 'silent').toLowerCase();
  const min = LEVELS[name] === undefined ? LEVELS.silent : LEVELS[name];
  const make = (bindings) => {
    const prefix = bindings && Object.keys(bindings).length ? `${safeInspect(bindings)} ` : '';
    const at = (lvl) => (...a) => {
      if (LEVELS[lvl] < min) return;
      // pino's signature is (mergeObject, msg) — flip it back to something readable.
      emit(lvl, [prefix, ...a.slice().reverse()]);
    };
    return {
      level: name,
      child: (b) => make({ ...bindings, ...b }),
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      fatal: at('fatal'),
      silent: () => {},
    };
  };
  return make({});
}

module.exports = { logger, pinoCompatible };
