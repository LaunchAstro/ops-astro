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
// - keeps each alert raised, its sink id fixed then (0048), and deletes the
//   errors sent, the signals an alert counted and the signals past their
//   rule's window; a send that fails rolls the pass back;
// - then sends the kept alerts, each deleted only once the sink took it, so a
//   retry after a lost answer sends the same id whatever commits later;
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

/** An event's id at the sink, fixed by what it stands for: a retry after a lost answer reuses it. */
const fixedId = (...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32);
const rowId = (row: Row): string => fixedId(row.id, row.at.toISOString());

type Execute = AdminConnection['execute'];
type Raised = { readonly kind: AlertKind; readonly id: string };

/**
 * Every row left, in order: each error sent, each signal counted. Returns the
 * ids to clear, exactly: the errors sent, the rows each raised alert counted,
 * and the signals read that are past their rule's window at `now`, the
 * database's own clock.
 */
async function replay(execute: Execute, options: ForwarderOptions, now: number, raised: Raised[]) {
  const spent: string[] = [];
  const held = new Map<string, Row[]>();
  let clock = 0;
  let current: Row | undefined;
  const detector = createDetector(
    (kind) => {
      if (current === undefined) return;
      const key = `${current.kind}\u0001${current.scope}`;
      raised.push({ kind, id: fixedId(kind, rowId(current)) });
      spent.push(...(held.get(key) ?? []).map((row) => row.id));
      held.delete(key);
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
        await options.send(rebuiltError(row.event, options, rowId(row)));
        spent.push(row.id);
        continue;
      }
      const signal = signalOf(row);
      if (signal === undefined) continue;
      const window = RULES[signal.kind].windowMs;
      const key = `${row.kind}\u0001${row.scope}`;
      const inWindow = (held.get(key) ?? []).filter(
        (r) => row.at.getTime() - r.at.getTime() < window,
      );
      held.set(key, [...inWindow, row]);
      if (now - row.at.getTime() >= window) spent.push(row.id);
      clock = row.at.getTime();
      current = row;
      detector.observe(signal);
    }
    if (rows.length < BATCH) break;
    after = rows.at(-1)?.id ?? after;
  }
  return { handled, spent };
}

/** Every alert kept, in the order raised; each leaves only once the sink took it. */
async function deliver(execute: Execute, options: ForwarderOptions): Promise<void> {
  await execute('set local role ops_astro_forwarder');
  await advisoryLock({ query: execute }, 'ops.api_events forwarder');
  const kept = await execute<Raised>('select id, kind from ops.api_alerts order by seq');
  for (const { kind, id } of kept) {
    // oxlint-disable-next-line no-await-in-loop -- in the order raised
    await options.send(alertEvent(kind, options.where, options.release, id));
  }
  await execute('delete from ops.api_alerts where id = any($1::text[])', [kept.map((a) => a.id)]);
}

export function createForwarder(options: ForwarderOptions): {
  readonly once: () => Promise<{ handled: number; dropped: number }>;
} {
  const pass = async (execute: Execute) => {
    await execute('set local role ops_astro_forwarder');
    await advisoryLock({ query: execute }, 'ops.api_events forwarder');
    const [stale] = await execute<{ dropped: number; last: string | null; now: Date }>(
      `with gone as (delete from ops.api_events where at < now() - make_interval(secs => $1)
         returning id) select count(*)::int as dropped, max(id)::text as last, now() from gone`,
      [WINDOW_MS / 1000],
    );
    const dropped = stale?.dropped ?? 0;
    const raised: Raised[] = [];
    if (dropped > 0) raised.push({ kind: 'signals-dropped', id: fixedId('dropped', stale!.last!) });
    const now = stale?.now.getTime() ?? Date.now();
    const { handled, spent } = await replay(execute, options, now, raised);
    // Each alert is kept with its id, fixed now, as the signals it counted go: a
    // send that fails leaves it to the next pass under the same id (0048).
    await execute(
      `insert into ops.api_alerts (id, kind)
         select id, kind from unnest($1::text[], $2::text[]) with ordinality as a(id, kind, n)
         order by n on conflict (id) do nothing`,
      [raised.map((alert) => alert.id), raised.map((alert) => alert.kind)],
    );
    await execute('delete from ops.api_events where id = any($1::bigint[])', [spent]);
    return { handled, dropped };
  };

  async function once(): Promise<{ handled: number; dropped: number }> {
    const done = await options.database.transaction(pass);
    await options.database.transaction(async (execute) => await deliver(execute, options));
    const beat = await options.heartbeat?.();
    // Only a ping the watcher took completes a pass: failed, refused or not set is silence.
    if (beat !== undefined && beat !== 'sent') throw new Error(`the heartbeat was ${String(beat)}`);
    return done;
  }

  return { once };
}
