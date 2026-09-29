// SPDX-License-Identifier: AGPL-3.0-only
//
// T3d2: the real worker as its own process, with the kill harness's one seam.
//
//   node tests/support/parking-worker.ts
//
// It builds the shipped worker (`apps/worker/worker.ts`) over the command
// line's HTTP transport, exactly as `apps/worker/main.ts` does, and applies
// the approved work on one task. The seam is the transport, wrapped here and
// nowhere else: when the answer to the named call arrives, the process writes
// `parked <point>` synchronously and stops itself with SIGSTOP. The harness
// then kills it from outside by its own pid (spike RN-02). Nothing under
// `apps/` or `packages/` imports this file, and `t3b-shipped-graph.test.ts`
// keeps `tests/` out of every shipped graph, so the seam ships nowhere.
//
// Like the worker it is a client of the API and nothing more: no database
// address is read or handed to it (RN-04).
//
// Environment: the worker's own (`OPS_ASTRO_API_URL`, `OPS_ASTRO_BUSINESS`,
// `OPS_ASTRO_TOKEN`, `OPS_ASTRO_DELEGATION`), plus `PARK_TASK` (the task),
// `PARK_AT` (a point below, or `none`) and `PARK_LEASE_SECONDS` (the lease the
// pickup asks for, so a killed worker's lease runs out on its own clock).

import { writeSync } from 'node:fs';
import { httpTransport, type Transport } from '../../apps/cli/client.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import { createWorker } from '../../apps/worker/worker.ts';

/** The named points: after the call whose path ends so has answered with success. */
export const PARK_POINTS = {
  'after-reservation': '/task/pickup',
  'after-dispatch-mark': '/task/dispatch',
  'after-effect': '/task/comment',
} as const;

export type ParkPoint = keyof typeof PARK_POINTS;

const env = process.env;
const api = (env['OPS_ASTRO_API_URL'] ?? '').replace(/\/$/u, '');
const taskId = env['PARK_TASK'] ?? '';
const at = env['PARK_AT'] ?? 'none';
const leaseSeconds = Number(env['PARK_LEASE_SECONDS'] ?? 900);
const parkOn = at === 'none' ? undefined : PARK_POINTS[at as ParkPoint];
if (api === '' || taskId === '' || (at !== 'none' && parkOn === undefined)) {
  writeSync(2, 'parking-worker: set OPS_ASTRO_API_URL, PARK_TASK and a known PARK_AT\n');
  process.exit(2);
}

const say = (line: string): void => {
  // Synchronous: a pipe write left pending would never leave a stopped process.
  writeSync(1, `${line}\n`);
};

const inner = httpTransport(api);
let parked = false;
const transport: Transport = async (path, body, bearer, delegation) => {
  const sent = path.endsWith('/task/pickup')
    ? JSON.stringify({ ...(JSON.parse(body) as object), leaseSeconds })
    : body;
  const answer = await inner(path, sent, bearer, delegation);
  if (!parked && parkOn !== undefined && path.endsWith(parkOn) && answer.ok) {
    parked = true;
    say(`parked ${at}`);
    process.kill(process.pid, 'SIGSTOP');
    // Continued (SIGCONT) rather than killed: the worker carries on from here.
    say(`continued ${at}`);
  }
  return answer;
};

const worker = createWorker({
  transport,
  businessKey: env['OPS_ASTRO_BUSINESS'] ?? '',
  credential: env['OPS_ASTRO_TOKEN'] ?? '',
  delegation: env['OPS_ASTRO_DELEGATION'] ?? '',
  reporter: SYNTHETIC_USAGE,
});

// One pass at a time until the work is applied or there is none left to pick up.
for (let pass = 0; pass < 60; pass += 1) {
  // oxlint-disable-next-line no-await-in-loop -- one pass at a time, by design
  const outcome = await worker.applyOnce(taskId).catch(() => ({ fault: { status: 0 } }));
  say(JSON.stringify(outcome));
  if ('applied' in outcome || 'idle' in outcome) process.exit(0);
  if ('refused' in outcome) process.exit(1);
  // oxlint-disable-next-line no-await-in-loop -- the poll interval
  await new Promise((done) => {
    setTimeout(done, 500);
  });
}
process.exit(4);
