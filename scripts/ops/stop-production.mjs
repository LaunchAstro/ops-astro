// SPDX-License-Identifier: AGPL-3.0-only
//
// The gated stop of production's worker and its forwarder (ticket S0-1, part S0-1g).
//
// Usage (the runbook sets the environment, the owner runs it):
//   node scripts/ops/stop-production.mjs
//
// The promotion migrates only with the production worker stopped (S0-1), so a
// person stops it first, and this is the only way the runbook stops it. The
// worker and its outbox forwarder are one unit on the machine (the forwarder
// holds a database session), so both stop together. The web app and sign-in
// are not on the machine: they are taken down by the maintenance deployment.
// It asks the operator gate first (`operator.ts`): a person's own sign-in
// holding `operations:manage`, or it refuses and does nothing. Then it asks
// Docker to stop exactly the two containers below with a fixed argument list:
// it takes no argument, so no caller can name another service. A container is
// stopped, never removed, so it can be started again. Last, it writes the
// deployment record. Exit 0 when both are stopped, 1 when refused or failed,
// 2 when given any argument.

import { spawnSync } from 'node:child_process';
import { recordDeployment, requireOperator } from './operator.ts';

/** Production's worker unit, as its definition names the containers. */
const SERVICES = ['ops-astro-worker', 'ops-astro-forwarder'];

if (process.argv.length > 2) {
  console.error("stop-production: takes no argument; it stops only production's worker unit");
  process.exit(2);
}

const gate = await requireOperator();
if (!gate.ok) {
  console.error(`stop-production: REFUSED: ${gate.reason}`);
  process.exit(1);
}

const stopped = spawnSync('docker', ['stop', ...SERVICES], { stdio: 'inherit' });
if (stopped.status !== 0) {
  console.error(
    'stop-production: FAILED: docker stop did not complete; no record written. ' +
      'Check both containers with the service manager before anything else.',
  );
  process.exit(1);
}
const record = await recordDeployment(gate, {
  action: 'production stopped',
  services: SERVICES.map((name) => `docker:${name}`),
});
console.log(`stop-production: stopped ${SERVICES.join(' and ')}; run the promotion next`);
console.log(JSON.stringify(record));
