// SPDX-License-Identifier: AGPL-3.0-only
//
// Staging preparation, the operator's command (ticket S0-1).
//
// Usage (the runbook sets the environment, the owner runs it):
//   node scripts/ops/operator.mjs prepare
//
// It asks the operator gate first (`operator.ts`): a person's own sign-in
// holding `operations:manage`, or it refuses and does nothing. Then it
// allocates staging's own containers, network and volume from
// deploy/staging/compose.json with `docker compose create`, which starts
// nothing: nothing is deployed to staging until S0-2 closes, and S0-6 makes
// the first deploy. Last, it writes the deployment record. Exit 0 when
// prepared, 1 when refused or failed, 2 when the arguments are unusable. The
// promotion step (`promote.mjs`) asks the same gate and writes the same record.

import { spawnSync } from 'node:child_process';
import { recordDeployment, requireOperator } from './operator.ts';

const DEFINITION = new URL('../../deploy/staging/compose.json', import.meta.url).pathname;

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== 'prepare') {
  console.error('operator: usage: node scripts/ops/operator.mjs prepare');
  process.exit(2);
}

const gate = await requireOperator();
if (!gate.ok) {
  console.error(`operator: REFUSED: ${gate.reason}`);
  process.exit(1);
}

// `create` allocates and starts nothing. Compose refuses while any
// `${STAGING_*}` value the runbook sets is missing.
const created = spawnSync('docker', ['compose', '--file', DEFINITION, 'create'], {
  stdio: 'inherit',
});
if (created.status !== 0) {
  console.error('operator: FAILED: docker compose create did not complete; no record written');
  process.exit(1);
}
const record = await recordDeployment(gate, {
  action: 'staging prepared',
  definition: 'deploy/staging/compose.json',
});
console.log(
  'operator: staging prepared: containers, network and volume allocated, nothing started',
);
console.log(JSON.stringify(record));
