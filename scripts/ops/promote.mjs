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
//     [--docker-inspect <file>] [--launchctl <file>]
//
// A dry run reads only the store: it asks nothing of the service manager and
// changes nothing. The record is printed as one JSON line. Exit 0 when promoted
// or dry-run, 1 when refused or failed, 2 when the arguments are unusable.
// The two file flags hand the service report a command's saved output instead.

import { execFileSync, spawnSync } from 'node:child_process';
import { renameSync, rmSync, symlinkSync } from 'node:fs';
import { parseService, promote } from './promotion.ts';

const REPORT = new URL('./service-report.mjs', import.meta.url).pathname;
const MIGRATE = new URL('../db-migrate.mjs', import.meta.url).pathname;

function usage(message) {
  console.error(`promote: ${message}`);
  process.exit(2);
}

function flag(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) usage(`${name} needs a value`);
  return value;
}

function service(args, name) {
  const text = flag(args, name);
  if (text === undefined) return undefined;
  try {
    return parseService(text);
  } catch (error) {
    return usage(error.message);
  }
}

const args = process.argv.slice(2);
const version = flag(args, '--version');
const store = flag(args, '--artefacts');
const line = flag(args, '--line');
if (version === undefined || store === undefined || line === undefined) {
  usage('--version, --artefacts and --line are all needed');
}
const request = { version, store, line, dryRun: args.includes('--dry-run') };
for (const [key, name] of [
  ['api', '--api'],
  ['auth', '--auth'],
]) {
  const named = service(args, name);
  if (named) request[key] = named;
}
const current = flag(args, '--current');
if (current !== undefined) request.current = current;

const effects = {
  services() {
    const passed = ['--docker-inspect', '--launchctl'].flatMap((name) => {
      const file = flag(args, name);
      return file === undefined ? [] : [name, file];
    });
    const out = execFileSync(process.execPath, [REPORT, 'snapshot', ...passed], {
      encoding: 'utf8',
    });
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
console.log(JSON.stringify(outcome.record));
