#!/usr/bin/env node
'use strict';

// Mirrors the losali convention of syntax-checking before committing, but for
// every file in the app rather than one entry point.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['src', 'scripts', 'tests'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failed = 0;
for (const file of DIRS.flatMap((d) => walk(path.join(ROOT, d)))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    process.stderr.write(`FAIL ${path.relative(ROOT, file)}\n${err.stderr}\n`);
  }
}

if (failed) {
  process.stderr.write(`${failed} file(s) failed the syntax check.\n`);
  process.exit(1);
}
process.stdout.write('Syntax check passed.\n');
