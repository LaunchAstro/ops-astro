// SPDX-License-Identifier: AGPL-3.0-only
// The security gate (CQ-15, standing gate 9): judges a `pnpm audit --json` or
// Semgrep `--json` report against .github/security-exceptions.json. Audit
// entries name a moderate GHSA id; high and critical are never excepted. Semgrep
// entries name a rule, a file and `matches`: for each finding, the first 16 hex
// of the sha256 of the bytes from its start.offset to its end.offset, so moved
// code still matches and other code in its place does not, and `file`: the same
// hash of the whole file, so any change to the reviewed file (a new caller of
// the flagged code included) fails until the exception is reviewed again. A
// file hash says nothing about callers in other files: an exported function's
// new caller elsewhere is left to the expiry and the review. Unlisted findings,
// scanner errors, empty scans, missing reports and exceptions that lack a field,
// are past or over a year out, or match nothing all fail. It prints rule, file
// and line, never the matched text or its hash: for p/secrets that is the secret.
//
// Usage: node scripts/security-gate.mjs audit|semgrep --report <file>
//          [--exceptions <file>] [--root <dir>] [--today YYYY-MM-DD]

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [kind, ...argv] = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const root = resolve(flag('root', resolve(import.meta.dirname, '..')));
const today = flag('today', new Date().toISOString().slice(0, 10));
const inAYear = new Date(Date.parse(today) + 366 * 86_400_000).toISOString().slice(0, 10);
const FIELDS = ['reason', 'impact', 'owner', 'control', 'expires'];
// 2026-02-30 compares as a string and would never lapse on time.
const isDay = (day) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(day) && new Date(Date.parse(day) || 0).toISOString().startsWith(day);

if (kind !== 'audit' && kind !== 'semgrep') {
  console.error('security-gate: the first argument is audit or semgrep');
  process.exit(2);
}
const failures = [];
const refuse = (line) => failures.push(line);
function load(path, what) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value !== null && typeof value === 'object') return value;
    throw new TypeError('not an object');
  } catch {
    refuse(`${what} at ${path} is missing or is not a JSON object`);
    return undefined;
  }
}

const report = load(flag('report', ''), `the ${kind} report`);
const file = flag(
  'exceptions',
  resolve(import.meta.dirname, '../.github/security-exceptions.json'),
);
const entries = load(file, 'the exceptions file')?.[kind] ?? [];
if (!Array.isArray(entries)) refuse(`exceptions.${kind} is not a list`);
const listed = Array.isArray(entries) ? entries : [];

// Every exception is whole and in date before any finding is matched to it.
for (const [i, e] of listed.entries()) {
  const at = `exceptions.${kind}[${i}]`;
  const empty = FIELDS.filter((f) => typeof e?.[f] !== 'string' || e[f].trim() === '');
  if (empty.length > 0) refuse(`${at} names no ${empty.join(', ')}`);
  else if (!isDay(e.expires)) refuse(`${at} expiry ${e.expires} is not a real YYYY-MM-DD date`);
  else if (e.expires > inAYear) refuse(`${at} expires ${e.expires}, more than a year out`);
  else if (e.expires < today) refuse(`${at} expired on ${e.expires}; review it again or fix it`);
}
const used = new Set();

if (kind === 'audit' && report !== undefined) {
  if (typeof report.advisories !== 'object' || report.advisories === null)
    refuse('the audit report carries no advisories object; the audit did not complete');
  for (const a of Object.values(report.advisories ?? {})) {
    const id = a.github_advisory_id ?? String(a.id);
    const where = `${a.module_name} ${id} (${a.severity})`;
    if (a.severity === 'high' || a.severity === 'critical')
      refuse(`${where}: a ${a.severity} advisory fails the gate; no exception covers it`);
    if (a.severity !== 'moderate') continue;
    const i = listed.findIndex((e) => e.advisory === id);
    if (i === -1) refuse(`${where}: a moderate advisory with no recorded exception`);
    used.add(i);
  }
}

/** The first 16 hex of the sha256 of a finding's matched bytes, or a refusal. */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
/** The bytes of a reported file, or none when it cannot be read. */
function source(path) {
  try {
    return readFileSync(join(root, path));
  } catch {
    return Buffer.alloc(0);
  }
}
function matched(r) {
  const bytes = source(r.path).subarray(r.start?.offset, r.end?.offset);
  if (bytes.length > 0) return hash(bytes);
  refuse(`${r.check_id} at ${r.path}:${r.start?.line}: its matched source cannot be read`);
  return 'unreadable';
}

if (kind === 'semgrep' && report !== undefined) {
  const errors = (report.errors ?? []).filter((e) => e.level !== 'warn');
  if (errors.length > 0) refuse(`Semgrep reported ${errors.length} error(s); a failed scan fails`);
  if (!Array.isArray(report.results)) refuse('the Semgrep report carries no results list');
  if ((report.paths?.scanned ?? []).length === 0) refuse('Semgrep scanned no file');
  const results = Array.isArray(report.results) ? report.results : [];
  const groups = Map.groupBy(results, (r) => `${r.check_id}\n${r.path}`);
  for (const [key, found] of groups) {
    const where = `${found[0].check_id} at ${found.map((r) => `${r.path}:${r.start?.line}`)}`;
    const hashes = found.map(matched).toSorted();
    const i = listed.findIndex((e) => `${e.rule}\n${e.path}` === key);
    const recorded = Array.isArray(listed[i]?.matches) ? listed[i].matches.toSorted() : [];
    if (i === -1) refuse(`${where}: a finding with no recorded exception`);
    else if (hashes.join() !== recorded.join())
      refuse(`${where}: its matched source is not the source the exception records`);
    else if (typeof listed[i].file !== 'string' || listed[i].file === '')
      refuse(`${where}: the exception names no file revision`);
    else if (hash(source(found[0].path)) !== listed[i].file)
      refuse(`${where}: the file changed since the exception was reviewed; review it again`);
    used.add(i);
  }
}

for (const [i, e] of listed.entries())
  if (!used.has(i)) refuse(`exceptions.${kind}[${i}] (${e?.rule ?? e?.advisory}) matched nothing`);

if (failures.length > 0) {
  console.error(`security-gate ${kind}: refused\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`security-gate ${kind}: clean, ${listed.length} exception(s) in date and matched`);
