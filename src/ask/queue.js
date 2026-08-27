'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * A durable, dependency-free job queue: one JSON file per job in a directory.
 *
 * Durability is the point. Subscription limits are windowed, so a question may
 * legitimately sit here for hours before it can be answered — it has to survive
 * a bot restart, a deploy, and a reboot. The whole design assumes the answer is
 * slow and the queue is the memory.
 *
 * Single writer (the bot process owns it), so no locking is needed.
 */

const PENDING = 'pending';
const DONE = 'done';

function createQueue({ dir, maxAttempts = 6 }) {
  const pendingDir = path.join(dir, PENDING);
  const doneDir = path.join(dir, DONE);

  function ensure() {
    fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(doneDir, { recursive: true, mode: 0o700 });
  }

  function jobPath(id) {
    return path.join(pendingDir, `${id}.json`);
  }

  function read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null; // a half-written or corrupt job must not wedge the queue
    }
  }

  function write(job) {
    const tmp = `${jobPath(job.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, jobPath(job.id)); // atomic: a crash never leaves a partial job
    return job;
  }

  function enqueue({ question, chatJid, senderJid, pushName, sessionId, messageId }) {
    ensure();
    const now = Date.now();
    const job = {
      id: `${now}-${crypto.randomBytes(4).toString('hex')}`,
      createdAt: new Date(now).toISOString(),
      question,
      chatJid,
      senderJid,
      pushName: pushName || '',
      sessionId,
      messageId: messageId || null,
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
    };
    return write(job);
  }

  /** Oldest job whose backoff has elapsed, or null. */
  function claimNext(now = Date.now()) {
    ensure();
    const names = fs.readdirSync(pendingDir).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const file = path.join(pendingDir, name);
      const job = read(file);
      if (!job) {
        // Unreadable: move it aside rather than retrying it forever.
        fs.renameSync(file, path.join(doneDir, `corrupt-${name}`));
        continue;
      }
      if (job.nextAttemptAt <= now) return job;
    }
    return null;
  }

  function complete(job, outcome) {
    ensure();
    const finished = { ...job, finishedAt: new Date().toISOString(), outcome };
    fs.writeFileSync(path.join(doneDir, `${job.id}.json`), JSON.stringify(finished, null, 2), { mode: 0o600 });
    fs.rmSync(jobPath(job.id), { force: true });
    return finished;
  }

  /**
   * Record a failed attempt and schedule a retry.
   * @param {number} [retryAfterMs] explicit wait (a rate-limit window), else backoff.
   */
  function fail(job, { error, retryAfterMs } = {}) {
    const attempts = job.attempts + 1;
    if (attempts >= maxAttempts && retryAfterMs === undefined) {
      return { job: complete({ ...job, attempts }, { ok: false, error, gaveUp: true }), gaveUp: true };
    }
    const backoff = retryAfterMs === undefined
      ? Math.min(2 ** attempts * 60_000, 6 * 3600_000) // 2m, 4m, 8m … capped at 6h
      : retryAfterMs;
    return {
      job: write({ ...job, attempts, nextAttemptAt: Date.now() + backoff, lastError: error || null }),
      gaveUp: false,
      retryInMs: backoff,
    };
  }

  function stats() {
    ensure();
    const pending = fs.readdirSync(pendingDir).filter((n) => n.endsWith('.json'));
    const now = Date.now();
    let ready = 0;
    for (const name of pending) {
      const job = read(path.join(pendingDir, name));
      if (job && job.nextAttemptAt <= now) ready += 1;
    }
    return { pending: pending.length, ready };
  }

  /** Answered jobs from the last `sinceMs`, used for the daily cap. */
  function completedSince(sinceMs, now = Date.now()) {
    ensure();
    let count = 0;
    for (const name of fs.readdirSync(doneDir)) {
      if (!name.endsWith('.json')) continue;
      const job = read(path.join(doneDir, name));
      if (!job || !job.finishedAt || !job.outcome || !job.outcome.ok) continue;
      if (now - Date.parse(job.finishedAt) <= sinceMs) count += 1;
    }
    return count;
  }

  return { enqueue, claimNext, complete, fail, stats, completedSince, pendingDir, doneDir };
}

module.exports = { createQueue };
