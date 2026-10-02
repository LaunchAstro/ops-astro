// SPDX-License-Identifier: AGPL-3.0-only
//
// The preview request's command (ticket S0-8, the create half). The decisions
// are in `preview.ts`; this file wires them to the person running it.
//
// Usage (the runbook sets PREVIEW_DEPLOY_HOOK, the previews project's hook
// address, and PREVIEWS_VERCEL_PROJECT_ID; the person is signed in to git as
// themself):
//   node scripts/ops/preview.mjs --version <full commit id>
//
// The installation's operator gate (`requireOperatingOperator`, `operator.ts`):
// a preview builds the whole product, so only a person holding
// `operations:manage` over the operating business may ask for one. It answers
// before any argument is read; a refusal pushes and builds nothing. The
// record is written only once the hook answers a job. Exit 0 when requested,
// 1 when refused or failed, 2 when the arguments are unusable.

import { parseArgs } from 'node:util';
import { recordDeployment, requireOperatingOperator } from './operator.ts';
import { gitPush, requestPreview } from './preview.ts';

const gate = await requireOperatingOperator();
if (!gate.ok) {
  console.error(`preview: REFUSED: ${gate.reason}`);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({ options: { version: { type: 'string' } } }));
} catch (error) {
  console.error(`preview: ${error.message}`);
  process.exit(2);
}
if (values.version === undefined) {
  console.error('preview: --version <full commit id> is required');
  process.exit(2);
}

const outcome = await requestPreview(
  { version: values.version },
  { env: process.env, push: (version) => gitPush(version, process.env), post: fetch },
);
if (outcome.kind !== 'requested') {
  console.error(`preview: ${outcome.kind.toUpperCase()}: ${outcome.reason}`);
  process.exit(1);
}
console.log(`preview: asked Vercel to build ${outcome.record.version} (job ${outcome.record.job})`);
console.log(JSON.stringify(await recordDeployment(gate, outcome.record)));
