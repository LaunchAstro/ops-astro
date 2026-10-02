// SPDX-License-Identifier: AGPL-3.0-only
//
// The security pass's findings, the command (ticket S0-5 item 7). The
// decisions are in `findings.ts`; this file runs them.
//
//   node scripts/security/findings.mjs --report <scan>=<zap.json> [--report ...]
//        --out <dir> [--redact-env <NAME> ...]
//
// Writes `findings.md` and `findings.json` into `--out`. Each `--redact-env`
// names a setting whose value (the scan login's token) is replaced wherever a
// report echoes it. Exit 0 when no blocker or major is open, 1 when one is or
// when a report is missing or unreadable, 2 on a usage mistake. It prints
// counts and scan names, never a report's contents.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findingsOf, findingsTable, ReportRefused, severityGate } from './findings.ts';

const usage = (why) => {
  console.error(`findings: ${why}`);
  process.exit(2);
};

const reports = [];
const secrets = [];
let out;
const args = process.argv.slice(2);
for (let at = 0; at < args.length; at += 2) {
  const [flag, value] = [args[at], args[at + 1]];
  if (value === undefined) usage(`${flag} takes a value`);
  if (flag === '--report') {
    const match = /^([a-z][a-z0-9-]*)=(.+)$/u.exec(value);
    if (match === null) usage('--report takes <scan>=<file>');
    reports.push({ scan: match[1], file: match[2] });
  } else if (flag === '--out') out = value;
  else if (flag === '--redact-env') secrets.push(process.env[value] ?? '');
  else usage(`unknown flag ${flag}`);
}
if (reports.length === 0 || out === undefined) usage('name at least one --report and --out');

const scans = [];
let unreadable = false;
for (const { scan, file } of reports) {
  try {
    scans.push(findingsOf(scan, JSON.parse(readFileSync(file, 'utf8')), secrets));
  } catch (error) {
    unreadable = true;
    const why =
      error instanceof ReportRefused
        ? error.message
        : `the ${scan} report could not be read (${error?.code ?? error?.name ?? 'error'})`;
    console.error(`findings: ${why}`);
  }
}

mkdirSync(out, { recursive: true });
const gate = severityGate(scans);
writeFileSync(join(out, 'findings.md'), findingsTable(scans));
writeFileSync(join(out, 'findings.json'), `${JSON.stringify({ gate, scans }, undefined, 2)}\n`);
console.log(
  `findings: blockers ${gate.blocker}, majors ${gate.major}, minors ${gate.minor}, ` +
    `informational ${gate.info}` +
    (unreadable ? '; a report was missing or unreadable' : ''),
);
process.exit(gate.fails || unreadable ? 1 : 0);
