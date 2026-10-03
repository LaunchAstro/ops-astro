// SPDX-License-Identifier: AGPL-3.0-only
//
// The security pass's findings, the command (S0-5 item 7; decisions in findings.ts).
//
//   node scripts/security/findings.mjs --report <scan>=<zap.json> [--report ...]
//        --out <dir> [--redact-env <NAME> ...] [--signed-in <scan> ...]
//
// Writes findings.md and findings.json. Each --redact-env names a setting whose
// value (the scan login's token) is replaced wherever a report echoes it; a scan
// named by --signed-in fails the run when most of its answers were 401. Exit 0
// with no blocker or major open, 1 with one or a missing, unreadable or
// signed-out report, 2 on a usage mistake. It prints counts, never contents.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findingsOf, findingsTable, ReportRefused, severityGate, signedOut } from './findings.ts';

const usage = (why) => {
  console.error(`findings: ${why}`);
  process.exit(2);
};

const reports = [];
const secrets = [];
const signedIn = [];
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
  else if (flag === '--signed-in') signedIn.push(value);
  else usage(`unknown flag ${flag}`);
}
if (reports.length === 0 || out === undefined) usage('name at least one --report and --out');

const scans = [];
const problems = [];
for (const { scan, file } of reports) {
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    scans.push(findingsOf(scan, report, secrets));
    if (signedIn.includes(scan) && signedOut(report))
      problems.push(`the ${scan} scan was not signed in: most of its answers were 401`);
  } catch (error) {
    problems.push(
      error instanceof ReportRefused
        ? error.message
        : `the ${scan} report could not be read (${error?.code ?? error?.name ?? 'error'})`,
    );
  }
}
for (const problem of problems) console.error(`findings: ${problem}`);

mkdirSync(out, { recursive: true });
const gate = severityGate(scans);
writeFileSync(join(out, 'findings.md'), findingsTable(scans, problems));
writeFileSync(join(out, 'findings.json'), `${JSON.stringify({ gate, scans }, undefined, 2)}\n`);
console.log(
  `findings: blockers ${gate.blocker}, majors ${gate.major}, minors ${gate.minor}, ` +
    `informational ${gate.info}`,
);
process.exit(gate.fails || problems.length > 0 ? 1 : 0);
