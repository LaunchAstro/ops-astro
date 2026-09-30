// SPDX-License-Identifier: AGPL-3.0-only
//
// The outbox forwarder's process (ticket S0-2; `apps/forwarder/forward.ts`).
//
//   node scripts/ops/forwarder.mjs [--once]
//
// Settings come from the environment (deploy/staging/README.md):
// `DATABASE_FORWARDER_URL`, a login that is a member of `ops_astro_forwarder`
// alone; the sink's `OPS_ERROR_SINK_DSN`, `OPS_ENVIRONMENT` and `OPS_RELEASE`;
// `OPS_FORWARDER_HEARTBEAT_URL`, the watcher's heartbeat. Exit 1 names a bad
// setting, never its value. A pass that fails prints its class alone and
// pings nothing, so silence is the alert.

import { join } from 'node:path';
import { sinkFrom } from '../../apps/api/alerts/sink.ts';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { ping } from './heartbeat.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

export async function main(argv, env) {
  const url = env['DATABASE_FORWARDER_URL'] ?? '';
  let sink;
  try {
    if (url === '') throw new Error('DATABASE_FORWARDER_URL is not set.');
    sink = sinkFrom(env);
    if (sink === undefined) throw new Error('OPS_ERROR_SINK_DSN is not set.');
  } catch (error) {
    process.stderr.write(`forwarder: ${error.message}\n`);
    return 1;
  }
  const database = connectAsAdmin(url, { source: 'forwarder' });
  const forwarder = createForwarder({
    ...sink,
    database,
    root: ROOT,
    heartbeat: () => ping(env['OPS_FORWARDER_HEARTBEAT_URL']),
  });
  const interval = Number(env['OPS_FORWARDER_INTERVAL_MS'] ?? 15_000);
  let failed = false;
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one pass at a time
      await forwarder.once();
      failed = false;
    } catch (error) {
      // The class only: a driver's message can carry the login's address.
      process.stderr.write(
        `forwarder: the pass failed (${error?.constructor?.name ?? 'unknown'})\n`,
      );
      failed = true;
    }
    if (argv.includes('--once')) break;
    // oxlint-disable-next-line no-await-in-loop -- the poll interval
    await new Promise((done) => {
      setTimeout(done, interval);
    });
  }
  await database.close();
  return failed ? 4 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2), process.env);
