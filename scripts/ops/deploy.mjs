// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging deploy's command (ticket S0-6). The decisions are in
// `deploy.ts`; this file wires them to the machine.
//
// Usage (the runbook sets the environment, the operator runs it):
//   node scripts/ops/deploy.mjs --version <id> --artefacts <store>
//
// The operator gate (`operator.ts`) answers before any argument is read and
// before Docker is asked; a refusal writes nothing. The live services are read
// through S0-1a's service report, never a saved one, and compared with its own
// compare. The app image is built from the artefact with
// deploy/staging/Dockerfile and handed to Compose by its id. The deployment
// record is written only once staging is up on its pinned images with every
// live service unchanged. Exit 0 when deployed, 1 when refused or failed, 2
// when the arguments are unusable.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deploy } from './deploy.ts';
import { recordDeployment, requireOperator } from './operator.ts';

const REPORT = new URL('./service-report.mjs', import.meta.url).pathname;
const DEFINITION = new URL('../../deploy/staging/compose.json', import.meta.url).pathname;
const DOCKERFILE = new URL('../../deploy/staging/Dockerfile', import.meta.url).pathname;

function usage(message) {
  console.error(`deploy: ${message}`);
  process.exit(2);
}

const gate = await requireOperator();
if (!gate.ok) {
  console.error(`deploy: REFUSED: ${gate.reason}`);
  process.exit(1);
}

const VALUED = new Set(['--version', '--artefacts']);
const args = process.argv.slice(2);
const given = new Map();
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at];
  if (!VALUED.has(arg)) usage(`${arg} is not an argument of the staging deploy`);
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) usage(`${arg} needs a value`);
  given.set(arg, value);
  at += 1;
}
const [version, store] = ['--version', '--artefacts'].map((n) => given.get(n));
if (version === undefined || store === undefined)
  usage('--version and --artefacts are both needed');

const definition = JSON.parse(readFileSync(DEFINITION, 'utf8'));
const containers = Object.entries(definition.services).map(([n, s]) => s.container_name ?? n);

const effects = {
  snapshot() {
    return execFileSync(process.execPath, [REPORT, 'snapshot'], { encoding: 'utf8' });
  },
  compare(before, after) {
    const folder = mkdtempSync(join(tmpdir(), 'ops-astro-deploy-'));
    try {
      writeFileSync(join(folder, 'before.json'), before);
      writeFileSync(join(folder, 'after.json'), after);
      const result = spawnSync(
        process.execPath,
        [REPORT, 'compare', join(folder, 'before.json'), join(folder, 'after.json')],
        { encoding: 'utf8' },
      );
      return { unchanged: result.status === 0, report: `${result.stdout}${result.stderr}`.trim() };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
  buildImage(artefact) {
    const out = execFileSync('docker', ['build', '--quiet', '--file', DOCKERFILE, artefact], {
      encoding: 'utf8',
    });
    return out.trim();
  },
  up(image) {
    execFileSync('docker', ['compose', '--file', DEFINITION, 'up', '--detach', '--wait'], {
      stdio: 'inherit',
      env: { ...process.env, OPS_ASTRO_STAGING_APP_IMAGE: image },
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
console.log(`deploy: staging runs ${outcome.record.artefact} as ${outcome.record.image}`);
console.log(JSON.stringify(await recordDeployment(gate, outcome.record)));
