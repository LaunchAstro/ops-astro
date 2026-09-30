// SPDX-License-Identifier: AGPL-3.0-only
//
// The outbox forwarder's process (ticket S0-2; `apps/forwarder/forward.ts`).
//
//   node scripts/ops/forwarder.mjs [--once]
//
// Settings come from the environment (deploy/staging/README.md):
// `DATABASE_FORWARDER_URL`, a login that is a member of `ops_astro_forwarder`
// alone; the sink's `OPS_ERROR_SINK_DSN`, `OPS_ENVIRONMENT` and `OPS_RELEASE`;
// `OPS_FORWARDER_HEARTBEAT_URL`, the watcher's heartbeat; `OPS_SINK_HEARTBEAT_URL`,
// the sink's, pinged after each pass while the sink's health page answers. On
// staging each must leave by the egress host setting given beside it (the
// `OPS_EGRESS_*` hosts the relay lists). Exit 1 names a bad setting, never its value. A pass that fails prints its class alone
// and does not ping its own heartbeat, so silence is the alert.

import { join } from 'node:path';
import { sinkFrom } from '../../apps/api/alerts/sink.ts';
import { createForwarder } from '../../apps/forwarder/forward.ts';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';
import { offEgress, ping, sinkAnswers } from './heartbeat.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

/** On staging, each address leaves by the egress host beside it (S0-1 egress allow-list). */
const offRoute = (env) =>
  offEgress(env, [
    ['DATABASE_FORWARDER_URL', 'OPS_EGRESS_POOLER_HOST', env['OPS_EGRESS_POOLER_PORT']],
    ['OPS_ERROR_SINK_DSN', 'OPS_EGRESS_SINK_HOST'],
    ['OPS_FORWARDER_HEARTBEAT_URL', 'OPS_EGRESS_HEARTBEAT_HOST'],
    ['OPS_SINK_HEARTBEAT_URL', 'OPS_EGRESS_HEARTBEAT_HOST'],
  ]);

export async function main(argv, env) {
  const url = env['DATABASE_FORWARDER_URL'] ?? '';
  let sink;
  try {
    if (url === '') throw new Error('DATABASE_FORWARDER_URL is not set.');
    if (!/^postgres(ql)?:$/u.test(URL.parse(url)?.protocol ?? '')) {
      throw new Error('DATABASE_FORWARDER_URL is not a database login (postgres://...).');
    }
    sink = sinkFrom(env);
    if (sink === undefined) throw new Error('OPS_ERROR_SINK_DSN is not set.');
    const off = offRoute(env);
    if (off !== undefined) throw new Error(`${off}.`);
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
    // The sink is on the machine, out of the watcher's sight: its heartbeat says it answers.
    // oxlint-disable-next-line no-await-in-loop -- one probe after each pass
    if (await sinkAnswers(env['OPS_ERROR_SINK_DSN'])) await ping(env['OPS_SINK_HEARTBEAT_URL']);
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
