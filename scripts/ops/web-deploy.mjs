// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging web deploy's command (ticket S0-6). The decisions are in
// `web-deploy.ts`; this file wires them to the person running it.
//
// Usage (the runbook sets the environment, the operator runs it, signed in to
// Vercel as themself; VERCEL_ORG_ID and VERCEL_PROJECT_ID name staging's
// project):
//   node scripts/ops/web-deploy.mjs --version <id> --artefacts <store>
//
// The operator gate (`operator.ts`) answers before any argument is read and
// before Vercel is asked; a refusal writes nothing. The deployment record is
// written only once Vercel reports the deployment in syd1 alone. Exit 0 when
// deployed, 1 when refused or failed, 2 when the arguments are unusable.

import { parseArgs } from 'node:util';
import { stagingSigns } from './deploy.ts';
import { recordDeployment, requireOperator } from './operator.ts';
import { deployWeb } from './web-deploy.ts';

const gate = await requireOperator();
if (!gate.ok) {
  console.error(`web-deploy: REFUSED: ${gate.reason}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: { version: { type: 'string' }, artefacts: { type: 'string' } },
  }));
} catch (error) {
  console.error(`web-deploy: ${error.message}`);
  process.exit(2);
}
if (values.version === undefined || values.artefacts === undefined) {
  console.error('web-deploy: --version and --artefacts are both needed');
  process.exit(2);
}

const outcome = await deployWeb(
  { version: values.version, store: values.artefacts },
  { env: process.env, preflight: stagingSigns },
);
if (outcome.kind !== 'deployed') {
  console.error(`web-deploy: ${outcome.kind.toUpperCase()}: ${outcome.reason}`);
  process.exit(1);
}
console.log(`web-deploy: staging serves ${outcome.record.version} at ${outcome.record.deployment}`);
console.log(JSON.stringify(await recordDeployment(gate, outcome.record)));
