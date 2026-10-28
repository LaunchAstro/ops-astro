// SPDX-License-Identifier: AGPL-3.0-only
//
// The web deploy's command (ticket S0-6), staging's unless `--production`.
// The decisions are in `web-deploy.ts`; this file wires them to the person
// running it.
//
// Usage (the runbook sets the environment, the operator runs it, signed in to
// Vercel as themself; VERCEL_ORG_ID and VERCEL_PROJECT_ID name the
// environment's project):
//   node scripts/ops/web-deploy.mjs --version <id> --artefacts <store> [--production]
//   node scripts/ops/web-deploy.mjs --maintenance --version <id> --artefacts <store> [--production]
//   node scripts/ops/web-deploy.mjs --maintenance [--production]
//   node scripts/ops/web-deploy.mjs [--maintenance] --version <id> --artefacts <store> --production --staging-off <reference>
//
// `--production` deploys to production (deploy/production/README.md): its
// database and sign-in addresses must be production's project, never
// staging's, and production's own preflight replaces made-up-only.
//
// `--staging-off <reference>`, production's alone and only with a version,
// names the owner's decision that turned staging off: the digest the release
// step recorded for the version stands in for staging's record, and the
// deploy record says so (#2285). Every other check stays.
//
// `--maintenance` puts the maintenance page on the main address (`maintenance
// recorded`); deploying a version again takes it off. Planned, it names that
// version and its store, and the page goes up only if that version's deploy
// passes its checks now (#1985). Bare, for an incident, it says it checked none.
//
// The installation's operator gate (`operator.ts`, requireOperatingOperator:
// the app and the maintenance page serve every business, so only the
// operating business's `operations:manage` deploys them) answers before any
// argument is read and before Vercel is asked; a refusal writes nothing. The deployment record is
// written only once Vercel reports the deployment ready on production, its
// output held to syd1 alone (`web-deploy.ts`). Exit 0 when deployed, 1 when
// refused or failed, 2 when the arguments are unusable.

import { parseArgs } from 'node:util';
import { preflightFor } from './deploy.ts';
import { authorisedAct } from './authorised-act.ts';
import { recordDeployment, requireOperatingOperator } from './operator.ts';
import { deployMaintenance, deployWeb } from './web-deploy.ts';

const gate = await requireOperatingOperator();
if (!gate.ok) {
  console.error(`web-deploy: REFUSED: ${gate.reason}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      version: { type: 'string' },
      artefacts: { type: 'string' },
      maintenance: { type: 'boolean' },
      production: { type: 'boolean' },
      'staging-off': { type: 'string' },
    },
  }));
} catch (error) {
  console.error(`web-deploy: ${error.message}`);
  process.exit(2);
}
const both = values.version !== undefined && values.artefacts !== undefined;
const either = values.version !== undefined || values.artefacts !== undefined;
if (values.maintenance ? either && !both : !both) {
  console.error(
    'web-deploy: --version and --artefacts together, or --maintenance with or without them',
  );
  process.exit(2);
}

const stagingOff = values['staging-off'];
if (stagingOff !== undefined && !(values.production && both)) {
  console.error('web-deploy: --staging-off goes with --production, --version and --artefacts');
  process.exit(2);
}

const environment = values.production ? 'production' : 'staging';
// Vercel is asked, and the deploy recorded, under the operator's held grant (#970).
let written;
const authorised = (work) =>
  authorisedAct(gate, async () => {
    const answer = await work();
    if (answer.kind === 'deployed') written = await recordDeployment(gate, answer.record);
    return answer;
  });
const request = { version: values.version, store: values.artefacts };
const deploy = {
  env: process.env,
  preflight: preflightFor(environment),
  environment,
  records: gate.records,
  authorised,
  stagingOff,
};
const outcome = values.maintenance
  ? await deployMaintenance({ env: process.env }, both ? { request, options: deploy } : undefined)
  : await deployWeb(request, deploy);
if (outcome.kind !== 'deployed') {
  console.error(`web-deploy: ${outcome.kind.toUpperCase()}: ${outcome.reason}`);
  process.exit(1);
}
if (outcome.unchecked !== undefined) console.error(`web-deploy: ${outcome.unchecked}`);
const serves = values.maintenance ? 'the maintenance page' : outcome.record.version;
console.log(`web-deploy: ${environment} serves ${serves} at ${outcome.record.deployment}`);
console.log(JSON.stringify(written ?? (await recordDeployment(gate, outcome.record))));
