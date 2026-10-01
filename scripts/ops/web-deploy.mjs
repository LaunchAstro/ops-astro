// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy's command (ticket S0-6). The decisions are in
// `web-deploy.ts`; this file wires them to the person running it.
//
// Usage (the runbook sets the environment, the operator runs it, signed in to
// Vercel as themself; VERCEL_ORG_ID and VERCEL_PROJECT_ID name staging's
// project):
//   node scripts/ops/web-deploy.mjs --version <id> --artefacts <store>
//   node scripts/ops/web-deploy.mjs --maintenance
//
// `--maintenance` puts the maintenance page on the main address (`maintenance
// recorded`); deploying a version again takes it off.
//
// The operator gate (`operator.ts`) answers before any argument is read and
// before Vercel is asked; a refusal writes nothing. The deployment record is
// written only once Vercel reports the deployment in syd1 alone. Exit 0 when
// deployed, 1 when refused or failed, 2 when the arguments are unusable.

import { parseArgs } from 'node:util';
import { stagingSigns } from './deploy.ts';
import { recordDeployment, requireOperator } from './operator.ts';
import { deployMaintenance, deployWeb } from './web-deploy.ts';

const gate = await requireOperator();
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
    },
  }));
} catch (error) {
  console.error(`web-deploy: ${error.message}`);
  process.exit(2);
}
const both = values.version !== undefined && values.artefacts !== undefined;
if (values.maintenance ? (values.version ?? values.artefacts) : !both) {
  console.error('web-deploy: either --version and --artefacts, or --maintenance alone');
  process.exit(2);
}

const outcome = values.maintenance
  ? await deployMaintenance({ env: process.env })
  : await deployWeb(
      { version: values.version, store: values.artefacts },
      { env: process.env, preflight: stagingSigns },
    );
if (outcome.kind !== 'deployed') {
  console.error(`web-deploy: ${outcome.kind.toUpperCase()}: ${outcome.reason}`);
  process.exit(1);
}
const serves = values.maintenance ? 'the maintenance page' : outcome.record.version;
console.log(`web-deploy: staging serves ${serves} at ${outcome.record.deployment}`);
console.log(JSON.stringify(await recordDeployment(gate, outcome.record)));
