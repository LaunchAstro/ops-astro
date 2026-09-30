// SPDX-License-Identifier: AGPL-3.0-only
//
// The outbox forwarder (S0-2 error outbox, the forwarder's half; the Vercel
// re-plan, section 11 step 2; the orchestrator's ruling STEP2-SHAPE). The API
// instances keep no count and reach no sink: they append to `ops.api_events`
// (0047). This process runs beside the worker on the environment's machine,
// on a login that is a member of `ops_astro_forwarder` alone, and takes that
// role in its own transaction. Each pass:
// - drops rows older than the window uncounted and raises one
//   `signals-dropped` alert for them, so a stopped forwarder leaves a bounded
//   table once it runs again;
// - deletes the rows it reads and, in the same transaction, sends each error
//   rebuilt from its allowlist (`rebuiltError`): a sink that fails rolls the
//   pass back, and the rows wait for the next one;
// - counts the signals under the detector's own rules, each row's time the
//   clock and its keyed digest the scope, and sends each alert raised;
// - pings its heartbeat once all of that has completed.
// It is its own app, not `apps/worker`: the worker is a client of the API and
// never connects (`worker-holds-no-database`).

import type { AdminConnection } from '../../packages/core-records/src/index.ts';
import type { AlertKind, Where } from '../api/alerts/catalogue.ts';
import { createDetector, type SecuritySignal } from '../api/alerts/detect.ts';
import { alertEvent, rebuiltError, type Transport } from '../api/alerts/sink.ts';

/** Rows older than this are dropped uncounted: the longest rule's window (export volume). */
export const WINDOW_MS: number = 60 * 60_000;
const BATCH = 500;

export interface ForwarderOptions {
  /** A login that is a member of `ops_astro_forwarder` and nothing else. */
  readonly database: AdminConnection;
  readonly send: Transport;
  readonly where: Where;
  /** The checkout it runs from: an error's frame must name a file in it. */
  readonly root: string;
  readonly release?: string;
  /** The watcher's heartbeat, pinged after a pass that completed. */
  readonly heartbeat?: () => Promise<unknown>;
}

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly scope: string;
  readonly weight: number;
  readonly event: unknown;
  readonly at: Date;
}

/** A row as the detector's signal: the keyed digest stands where the scope's parts stood. */
function signalOf({ kind, scope, weight }: Row): SecuritySignal | undefined {
  switch (kind) {
    case 'sign-in-failed':
    case 'cross-scope-refusal':
      return { kind, business: scope, person: '' };
    case 'webhook-signature-failed':
      return { kind, business: scope, source: '' };
    case 'export':
      return { kind, business: scope, who: '', items: weight };
    case 'authority-changed':
      return { kind, business: scope };
    case 'secret-scan-failed':
      return { kind };
    default:
      return undefined;
  }
}

/** One batch, in the forwarder's own transaction: the stale dropped, the rest taken, errors sent. */
async function take(options: ForwarderOptions): Promise<{ dropped: number; rows: readonly Row[] }> {
  return await options.database.transaction(async (execute) => {
    await execute('set local role ops_astro_forwarder');
    const [stale] = await execute<{ dropped: number }>(
      `with gone as (delete from ops.api_events where at < now() - make_interval(secs => $1)
         returning 1) select count(*)::int as dropped from gone`,
      [WINDOW_MS / 1000],
    );
    const rows = await execute<Row>(
      `delete from ops.api_events where id in (select id from ops.api_events order by id limit $1)
         returning id, kind, scope, weight, event, at`,
      [BATCH],
    );
    for (const row of rows) {
      // oxlint-disable-next-line no-await-in-loop -- one error at a time, inside the pass
      if (row.kind === 'error') await options.send(rebuiltError(row.event, options));
    }
    return { dropped: stale?.dropped ?? 0, rows };
  });
}

export function createForwarder(options: ForwarderOptions): {
  readonly once: () => Promise<{ handled: number; dropped: number }>;
} {
  let clock = 0;
  const raised: AlertKind[] = [];
  const detector = createDetector((kind) => raised.push(kind), { now: () => clock });

  async function once(): Promise<{ handled: number; dropped: number }> {
    let handled = 0;
    let dropped = 0;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one batch after another
      const pass = await take(options);
      dropped += pass.dropped;
      handled += pass.rows.length;
      const ordered = pass.rows.toSorted(
        (a, b) => a.at.getTime() - b.at.getTime() || Number(a.id) - Number(b.id),
      );
      for (const row of ordered) {
        const signal = signalOf(row);
        clock = row.at.getTime();
        if (signal !== undefined) detector.observe(signal);
      }
      if (pass.rows.length < BATCH) break;
    }
    if (dropped > 0) raised.push('signals-dropped');
    // An alert leaves the queue once sent: a sink that fails keeps it for the next pass.
    for (let kind = raised[0]; kind !== undefined; kind = raised[0]) {
      // oxlint-disable-next-line no-await-in-loop -- in the order raised
      await options.send(alertEvent(kind, options.where, options.release));
      raised.shift();
    }
    await options.heartbeat?.();
    return { handled, dropped };
  }

  return { once };
}
