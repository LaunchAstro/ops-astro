// SPDX-License-Identifier: AGPL-3.0-only
// The security gate (CQ-15, standing gate 9): judges a `pnpm audit --json` or
// Semgrep `--json` report against .github/security-exceptions.json (audit entries
// by GHSA id, Semgrep entries by rule, file and exact count). It fails on
// a high or critical advisory (never excepted), an unlisted moderate one, an
// unlisted Semgrep finding or a count other than the recorded one, a scanner
// error, an empty scan, a missing report, and an exception lacking a field,
// expired, over a year out or matching nothing. It prints rule, file and line,
// never the matched text, which for a p/secrets finding is the secret.
//
// Usage: node scripts/security-gate.mjs audit|semgrep --report <file>
//          [--exceptions <file>] [--today YYYY-MM-DD]

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [kind, ...argv] = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
};
const root = resolve(import.meta.dirname, '..');
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
const file = flag('exceptions', join(root, '.github/security-exceptions.json'));
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

if (kind === 'semgrep' && report !== undefined) {
  const errors = (report.errors ?? []).filter((e) => e.level !== 'warn');
  if (errors.length > 0) refuse(`Semgrep reported ${errors.length} error(s); a failed scan fails`);
  if (!Array.isArray(report.results)) refuse('the Semgrep report carries no results list');
  if ((report.paths?.scanned ?? []).length === 0) refuse('Semgrep scanned no file');
  const results = Array.isArray(report.results) ? report.results : [];
  const groups = Map.groupBy(results, (r) => `${r.check_id}\n${r.path}`);
  for (const [key, found] of groups) {
    const where = `${found[0].check_id} at ${found.map((r) => `${r.path}:${r.start?.line}`)}`;
    const i = listed.findIndex((e) => `${e.rule}\n${e.path}` === key);
    if (i === -1) refuse(`${where}: a finding with no recorded exception`);
    else if (found.length !== listed[i].count)
      refuse(`${where}: ${found.length} finding(s), the exception records ${listed[i].count}`);
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
