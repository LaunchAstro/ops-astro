// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging deploy's command (ticket S0-6). The decisions are in
// `deploy.ts`; this file wires them to the machine.
//
// Usage (the runbook sets the environment, the operator runs it):
//   node scripts/ops/deploy.mjs --version <id> --artefacts <store>
//
// The installation's operator gate (`operator.ts`, requireOperatingOperator:
// operations:manage in the installation's operating business, since the
// services are the installation's, not one business's) answers before any
// argument is read and before Docker is asked; a refusal writes nothing. The
// live services are read through S0-1a's service report, never a saved one,
// and compared with its own compare, both imported. It builds no image: the app is on Vercel
// (`web-deploy.mjs`), and Compose starts the M5's unit on its pinned images.
// The deployment record is written only once staging is up on its pinned
// images with every live service unchanged. Exit 0 when deployed, 1 when
// refused or failed, 2 when the arguments are unusable.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deploy } from './deploy.ts';
import { recordDeployment, requireOperatingOperator } from './operator.ts';
import { compare, snapshot } from './service-report.mjs';

const DEFINITION = new URL('../../deploy/staging/compose.json', import.meta.url).pathname;

function usage(message) {
  console.error(`deploy: ${message}`);
  process.exit(2);
}

const gate = await requireOperatingOperator();
if (!gate.ok) {
  console.error(`deploy: REFUSED: ${gate.reason}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: { version: { type: 'string' }, artefacts: { type: 'string' } },
  }));
} catch (error) {
  usage(error.message);
}
const { version, artefacts: store } = values;
if (version === undefined || store === undefined)
  usage('--version and --artefacts are both needed');

const definition = JSON.parse(readFileSync(DEFINITION, 'utf8'));
const containers = Object.entries(definition.services).map(([n, s]) => s.container_name ?? n);

const effects = {
  snapshot,
  compare,
  up() {
    execFileSync('docker', ['compose', '--file', DEFINITION, 'up', '--detach', '--wait'], {
      stdio: 'inherit',
    });
  },
  imageId(ref) {
    const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], {
      encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout.trim() : undefined;
  },
  runningImages() {
    const result = spawnSync(
      'docker',
      ['inspect', '--format', '{{.Name}} {{.Image}}', ...containers],
      {
        encoding: 'utf8',
      },
    );
    return Object.fromEntries(
      result.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' '))
        .map(([name, image]) => [name.replace(/^\//u, ''), image]),
    );
  },
};

let outcome;
try {
  outcome = await deploy({ version, store }, effects);
} catch (error) {
  // A service manager that cannot be read, a build or a Compose run that
  // fails: say so plainly; no record is written.
  console.error(`deploy: FAILED part way: ${error.message}`);
  console.error('deploy: no record was written; check staging with docker compose ps');
  process.exit(1);
}
if (outcome.kind !== 'deployed') {
  console.error(`deploy: ${outcome.kind.toUpperCase()}: ${outcome.reason}`);
  process.exit(1);
}
console.log(`deploy: staging's M5 unit runs beside ${outcome.record.artefact}`);
console.log(JSON.stringify(await recordDeployment(gate, outcome.record)));
