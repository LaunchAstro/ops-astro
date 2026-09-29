// SPDX-License-Identifier: AGPL-3.0-only
//
// The promotion step's command (ticket S0-1). The decisions are in
// `promotion.ts`; this file wires them to the machine: the service manager is
// read through S0-1a's service report, the migration is `scripts/db-migrate.mjs`
// (which reads DATABASE_ADMIN_URL from the environment the runbook sets), and
// production is pointed at the artefact by swapping one link.
//
// Usage:
//   node scripts/ops/promote.mjs --dry-run --version <id> --artefacts <store> --line "<text>"
//   node scripts/ops/promote.mjs --version <id> --artefacts <store> --line "<text>" \
//     --api docker:<name>|launchd:<label> --auth docker:<name>|launchd:<label> --current <link>
//
// A dry run reads only the store: it asks nothing of the service manager and
// changes nothing. The record is printed as one JSON line. Exit 0 when promoted
// or dry-run, 1 when refused or failed, 2 when the arguments are unusable.
// A promotion reads the live service manager, never a saved report: a report
// file handed in could say stopped while the API runs, so the report's file
// flags are refused here, and so is any argument the step does not know.
//
// A real run is a person's act under `operations:manage` (S0-1e): the operator
// gate (`operator.ts`) answers before any argument is read and before the
// service manager is asked, and the deployment record is written only once
// production serves the artefact. A dry run reads only the store and changes
// nothing, so CI runs it with no sign-in and it writes no record.

import { execFileSync, spawnSync } from 'node:child_process';
import { renameSync, rmSync, symlinkSync } from 'node:fs';
import { recordDeployment, requireOperator } from './operator.ts';
import { parseService, promote } from './promotion.ts';

const REPORT = new URL('./service-report.mjs', import.meta.url).pathname;
const MIGRATE = new URL('../db-migrate.mjs', import.meta.url).pathname;

function usage(message) {
  console.error(`promote: ${message}`);
  process.exit(2);
}

const VALUED = new Set(['--version', '--artefacts', '--line', '--api', '--auth', '--current']);
const SAVED_REPORT = new Set(['--docker-inspect', '--launchctl']);

const args = process.argv.slice(2);
// No valued argument takes a value starting `--`, so this is the flag itself.
const gate = args.includes('--dry-run') ? null : await requireOperator();
if (gate && !gate.ok) {
  console.error(`promote: REFUSED: ${gate.reason}`);
  process.exit(1);
}

const given = new Map();
let dryRun = false;
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at];
  if (arg === '--dry-run') dryRun = true;
  else if (SAVED_REPORT.has(arg)) {
    console.error(
      `promote: REFUSED: ${arg} hands in a saved report; a promotion reads the live service manager, never a saved report`,
    );
    process.exit(1);
  } else if (VALUED.has(arg)) {
    const value = args[at + 1];
    if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
    given.set(arg, value);
    at += 1;
  } else usage(`${arg} is not an argument of the promotion step`);
}

function service(name) {
  const text = given.get(name);
  if (text === undefined) return undefined;
  try {
    return parseService(text);
  } catch (error) {
    return usage(error.message);
  }
}

const [version, store, line] = ['--version', '--artefacts', '--line'].map((n) => given.get(n));
if (version === undefined || store === undefined || line === undefined) {
  usage('--version, --artefacts and --line are all needed');
}
const request = { version, store, line, dryRun };
const api = service('--api');
if (api) request.api = api;
const auth = service('--auth');
if (auth) request.auth = auth;
if (given.has('--current')) request.current = given.get('--current');

const effects = {
  services() {
    const out = execFileSync(process.execPath, [REPORT, 'snapshot'], { encoding: 'utf8' });
    return JSON.parse(out).services;
  },
  migrate() {
    return spawnSync(process.execPath, [MIGRATE], { stdio: 'inherit' }).status === 0;
  },
  point(link, artefact) {
    const next = `${link}.promoting`;
    rmSync(next, { force: true });
    symlinkSync(artefact, next);
    renameSync(next, link);
  },
  start(target) {
    if (target.manager === 'docker') execFileSync('docker', ['start', target.name]);
    else execFileSync('launchctl', ['kickstart', `gui/${process.getuid()}/${target.name}`]);
    console.log(`promote: started ${target.manager}:${target.name}`);
  },
};

let outcome;
try {
  outcome = promote(request, effects);
} catch (error) {
  // A service manager that cannot be read, or a start that fails after the
  // migration: say so plainly, so the operator checks both services by hand.
  console.error(`promote: FAILED part way: ${error.message}`);
  console.error('promote: check the API and the auth server with the service manager');
  process.exit(1);
}
if (outcome.kind === 'refused' || outcome.kind === 'failed') {
  console.error(`promote: ${outcome.kind.toUpperCase()}: ${outcome.reason}`);
  process.exit(1);
}
console.log(
  outcome.kind === 'dry-run'
    ? `promote: dry run: would promote ${outcome.artefactPath}; nothing asked of the machine, nothing changed`
    : `promote: production now serves ${outcome.artefactPath}`,
);
console.log(JSON.stringify(gate ? await recordDeployment(gate, outcome.record) : outcome.record));
