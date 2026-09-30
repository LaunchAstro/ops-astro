// SPDX-License-Identifier: AGPL-3.0-only
//
// The outbox forwarder (S0-2 error outbox, the forwarder's half; the Vercel
// re-plan, section 11 step 2; the orchestrator's ruling STEP2-SHAPE). The API
// instances keep no count and reach no sink: they append to `ops.api_events`
// (0047). This process runs beside the worker on the environment's machine,
// on a login that is a member of `ops_astro_forwarder` alone, and takes that
// role in its own transaction, under one lock whichever forwarder runs. The
// counts are the table's rows, never one process's memory. Each pass:
// - drops rows older than the window uncounted and raises one
//   `signals-dropped` alert for them, so a stopped forwarder leaves a bounded
//   table once it runs again;
// - reads every row left, in order: sends each error rebuilt from its
//   allowlist (`rebuiltError`) under an id fixed by its row, and counts the
//   signals under the detector's own rules, each row's time the clock and its
//   keyed digest the scope;
// - sends each alert raised, then deletes the errors sent, the signals an
//   alert counted and the signals past their rule's window; a send that fails
//   rolls the pass back, and every row waits for the next one;
// - pings its heartbeat once that has committed, and fails if the ping did.
// It is its own app, not `apps/worker`: the worker is a client of the API and
// never connects (`worker-holds-no-database`).

import { createHash } from 'node:crypto';
import { advisoryLock, type AdminConnection } from '../../packages/core-records/src/index.ts';
import type { AlertKind, Where } from '../api/alerts/catalogue.ts';
import { createDetector, RULES, type SecuritySignal } from '../api/alerts/detect.ts';
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

/** An error's id at the sink, fixed by its row: a retry after a lost answer is the same event. */
const eventId = (row: Row): string =>
  createHash('sha256').update(`${row.id}\u0001${row.at.toISOString()}`).digest('hex').slice(0, 32);

/** Each rule's window in seconds, for the database to judge a signal past it. */
const WINDOWS = JSON.stringify(
  Object.fromEntries(Object.entries(RULES).map(([kind, rule]) => [kind, rule.windowMs / 1000])),
);

export function createForwarder(options: ForwarderOptions): {
  readonly once: () => Promise<{ handled: number; dropped: number }>;
} {
  const pass = async (execute: AdminConnection['execute']) => {
    await execute('set local role ops_astro_forwarder');
    await advisoryLock({ query: execute }, 'ops.api_events forwarder');
    const [stale] = await execute<{ dropped: number }>(
      `with gone as (delete from ops.api_events where at < now() - make_interval(secs => $1)
         returning 1) select count(*)::int as dropped from gone`,
      [WINDOW_MS / 1000],
    );
    const dropped = stale?.dropped ?? 0;
    const raised: AlertKind[] = dropped > 0 ? ['signals-dropped'] : [];
    const sent: string[] = [];
    const counted: { kind: string; scope: string; id: string }[] = [];
    let clock = 0;
    let current: Row | undefined;
    const detector = createDetector(
      (kind) => {
        raised.push(kind);
        if (current !== undefined) counted.push(current);
      },
      { now: () => clock },
    );
    let handled = 0;
    for (let after = '0'; ;) {
      // oxlint-disable-next-line no-await-in-loop -- one batch after another
      const rows = await execute<Row>(
        `select id, kind, scope, weight, event, at from ops.api_events
           where id > $1 order by id limit $2`,
        [after, BATCH],
      );
      handled += rows.length;
      for (const row of rows.toSorted((a, b) => a.at.getTime() - b.at.getTime())) {
        if (row.kind === 'error') {
          // oxlint-disable-next-line no-await-in-loop -- one error at a time, inside the pass
          await options.send(rebuiltError(row.event, options, eventId(row)));
          sent.push(row.id);
          continue;
        }
        const signal = signalOf(row);
        clock = row.at.getTime();
        current = row;
        if (signal !== undefined) detector.observe(signal);
      }
      if (rows.length < BATCH) break;
      after = rows.at(-1)?.id ?? after;
    }
    for (const kind of raised) {
      // oxlint-disable-next-line no-await-in-loop -- in the order raised
      await options.send(alertEvent(kind, options.where, options.release));
    }
    await execute(
      `delete from ops.api_events e where e.id = any($1::bigint[])
         or exists (select 1 from unnest($2::text[], $3::text[], $4::bigint[]) as c(kind, scope, id)
           where c.kind = e.kind and c.scope = e.scope and e.id <= c.id)
         or (e.kind <> 'error' and e.at < now() - make_interval(secs => ($5::jsonb ->> e.kind)::float8))`,
      [
        sent,
        counted.map((row) => row.kind),
        counted.map((row) => row.scope),
        counted.map((row) => row.id),
        WINDOWS,
      ],
    );
    return { handled, dropped };
  };

  async function once(): Promise<{ handled: number; dropped: number }> {
    const done = await options.database.transaction(pass);
    const beat = await options.heartbeat?.();
    if (beat === 'failed' || beat === 'refused') throw new Error(`the heartbeat was ${beat}`);
    return done;
  }

  return { once };
}
