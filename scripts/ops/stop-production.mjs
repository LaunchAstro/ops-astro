// SPDX-License-Identifier: AGPL-3.0-only
//
// The gated stop of production's API and auth server (ticket S0-1, part S0-1g).
//
// Usage (the runbook sets the environment, the owner runs it):
//   node scripts/ops/stop-production.mjs
//
// The promotion step refuses while the API or the auth server runs (owner
// line 63), so a person stops them first, and this is the only way the
// runbook stops them. It asks the operator gate first (`operator.ts`): a
// person's own sign-in holding `operations:manage`, or it refuses and does
// nothing. Then it asks Docker to stop exactly the two services below with a
// fixed argument list: it takes no argument, so no caller can name another
// service. A container is stopped, never removed, so the promotion still finds
// it and can start it again. Last, it writes the deployment record. Exit 0 when
// both are stopped, 1 when refused or failed, 2 when given any argument.

import { spawnSync } from 'node:child_process';
import { recordDeployment, requireOperator } from './operator.ts';

/** Production's API and auth server, as S0-6's deploy names their containers. */
const SERVICES = ['ops-astro-api', 'ops-astro-auth'];

if (process.argv.length > 2) {
  console.error(
    "stop-production: takes no argument; it stops only production's API and auth server",
  );
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
      'Check both services with the service manager before anything else.',
  );
  process.exit(1);
}
const record = await recordDeployment(gate, {
  action: 'production stopped',
  services: SERVICES.map((name) => `docker:${name}`),
});
console.log(`stop-production: stopped ${SERVICES.join(' and ')}; run the promotion next`);
console.log(JSON.stringify(record));
