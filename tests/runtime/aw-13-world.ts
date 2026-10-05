// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13's world: a stand-in trace target on loopback that can be told to
// misbehave, custody started with it as its one destination and a planted
// canary as the target's key, and the exporter's delivery through custody's
// egress, as the composition root wires it. Nothing here is hosted, bought or
// signed up for; `close` removes the target, custody and the key file.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll } from 'vitest';
import { deliverThrough, expiryThrough, traceDestination } from '../../apps/api/trace-exporter.ts';
import { startCustody, type Custody } from '../../packages/core-custody/src/index.ts';
import {
  exportOnce,
  type Deliver,
  type ExpiryPorts,
  type ExportOutcome,
} from '../../packages/core-runtime/src/index.ts';
import { openSchedules, rows, seedSchedules, type Schedules } from './schedules-harness.ts';

export type TargetMode =
  'ok' | 'redirect' | 'slow' | 'oversized' | 'malformed' | 'refusing' | 'down' | 'skipping';

export interface TraceTarget {
  mode: TargetMode;
  /** Every body the target received, in order, with its path and authorization. */
  readonly received: string[];
  readonly paths: string[];
  readonly authorizations: (string | undefined)[];
  /** Each request's method and fixed ingestion header, in order. */
  readonly methods: string[];
  readonly ingestion: (string | undefined)[];
  /** Trace ids the target holds, and their span ids: an export adds, a delete not skipped drops. */
  readonly stored: Set<string>;
  readonly spans: Map<string, Set<string>>;
  readonly origin: string;
  readonly custody: Custody;
  readonly canary: string;
  readonly deliver: Deliver;
  readonly expiry: ExpiryPorts;
  close(): Promise<void>;
}

export const TRACE_KEY: Buffer = Buffer.from('aw13-test-trace-key-not-a-secret');

/**
 * The trace store's side: an export stores spans by trace id; a delete drops whole traces unless
 * the target is `skipping` (success for work its guard skipped); a read of a trace or one of
 * its spans 404s once it is gone.
 */
function store(target: TraceTarget, method: string, url: string, body: string): number {
  if (method === 'POST') {
    const spans = /"traceId":"([0-9a-f]{32})","spanId":"([0-9a-f]{16})"/gu;
    for (const [, traceId = '', spanId = ''] of body.matchAll(spans)) {
      target.stored.add(traceId);
      target.spans.set(traceId, (target.spans.get(traceId) ?? new Set<string>()).add(spanId));
    }
  } else if (method === 'DELETE' && target.mode !== 'skipping') {
    for (const id of (JSON.parse(body) as { traceIds: string[] }).traceIds) {
      target.stored.delete(id);
      target.spans.delete(id);
    }
  } else if (method === 'GET') {
    const id = url.split('/').at(-1) ?? '';
    const held = url.includes('/observations/') ? [...target.spans.values()] : [target.stored];
    return held.some((ids) => ids.has(id)) ? 200 : 404;
  }
  return 200;
}

function answer(
  target: TraceTarget,
  response: import('node:http').ServerResponse,
  status: number,
): void {
  if (status === 404) {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    return;
  }
  switch (target.mode) {
    case 'redirect':
      response.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' }).end();
      return;
    case 'oversized':
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ padding: 'x'.repeat(64_000) }));
      return;
    case 'malformed':
      response.writeHead(200, { 'content-type': 'application/json' }).end('<html>not json');
      return;
    case 'refusing':
      response.writeHead(503, { 'content-type': 'application/json' }).end('{}');
      return;
    default:
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  }
}

/** The stand-in target on a loopback port, answering as `target.mode` says. */
async function listen(
  target: TraceTarget,
  received: string[],
): Promise<{ server: Server; port: number }> {
  const server: Server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(parts).toString('utf8');
      received.push(body);
      target.paths.push(request.url ?? '');
      target.authorizations.push(request.headers.authorization);
      target.methods.push(request.method ?? '');
      target.ingestion.push(request.headers['x-langfuse-ingestion-version'] as string | undefined);
      const status =
        target.mode === 'ok' || target.mode === 'skipping'
          ? store(target, request.method ?? '', request.url ?? '', body)
          : 200;
      if (target.mode === 'slow') {
        void sleep(2_000).then(() => answer(target, response, status));
        return;
      }
      if (target.mode === 'down') {
        request.socket.destroy();
        return;
      }
      answer(target, response, status);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

/** Custody with the target as its one destination and the canary as its key. */
async function custodyFor(folder: string, port: number, canary: string): Promise<Custody> {
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'trace_key',
        kind: 'api_key',
        account: 'trace-target-1',
        destination: 'trace_target',
        header: 'authorization',
        value: canary,
      },
    ]),
    { mode: 0o600 },
  );
  return await startCustody({
    credentialsFile,
    destinations: [traceDestination(`http://127.0.0.1:${String(port)}`)],
  });
}

export async function openTraceTarget(): Promise<TraceTarget> {
  const folder = mkdtempSync(join(tmpdir(), 'aw13-target-'));
  const canary = `canary-${randomBytes(18).toString('hex')}`;
  const received: string[] = [];
  const paths: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const target = {
    mode: 'ok',
    received,
    paths,
    authorizations,
    methods: [],
    ingestion: [],
    stored: new Set<string>(),
    spans: new Map<string, Set<string>>(),
  } as unknown as TraceTarget;
  const { server, port } = await listen(target, received);
  const custody = await custodyFor(folder, port, canary);
  return Object.assign(target, {
    origin: `http://127.0.0.1:${String(port)}`,
    custody,
    canary,
    // The composition root's delivery; 500 ms so the slow case is quick.
    deliver: deliverThrough(custody, 500),
    expiry: expiryThrough(custody, 500),
    close: async () => {
      await custody.stop();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
      rmSync(folder, { recursive: true, force: true });
    },
  });
}

export const noDatabase: boolean = process.env['DATABASE_URL'] === undefined;

/** The suite's world: two businesses on one database and the target. */
export const t = {} as { alpha: Schedules; bravo: Schedules; target: TraceTarget };

export function useAw13World(part: string): void {
  beforeAll(async () => {
    if (noDatabase) return;
    t.alpha = await openSchedules(part, 1_000_000);
    t.bravo = await seedSchedules(t.alpha.db, `${part}-bravo`, 1_000_000);
    t.target = await openTraceTarget();
  }, 180_000);
  afterAll(async () => {
    if (noDatabase) return;
    await t.target.close();
    await t.alpha.db.drop();
  });
}

export async function exportFor(s: Schedules): Promise<ExportOutcome> {
  return await exportOnce(t.alpha.db.app, s.business, TRACE_KEY, t.target.deliver);
}

/**
 * One export once there is something to send: the events a case just wrote
 * wait below the horizon until every older transaction on the cluster ends.
 */
export async function exportDue(s: Schedules): Promise<ExportOutcome> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- until the events are due
    const outcome = await exportFor(s);
    if (outcome.kind !== 'idle') return outcome;
    // eslint-disable-next-line no-await-in-loop -- waiting out the horizon
    await sleep(50);
  }
  throw new Error('no event became due');
}

/** Wait until an event ahead of the cursor is below the horizon; once due it stays due. */
export async function awaitDue(s: Schedules): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- until the events are due
    if ((await ahead(s, 'and ev.tx < pg_snapshot_xmin(pg_current_snapshot())')) > 0) return;
    // eslint-disable-next-line no-await-in-loop -- waiting out the horizon
    await sleep(50);
  }
  throw new Error('no event became due');
}

/** The gaps whose body the target may have stored all the same (`trace-lease.ts`). */
const MAYBE_STORED_GAP =
  'target_timeout,target_unreachable,target_malformed_reply,target_oversized_reply';

/**
 * Export until every event of the business is behind the cursor, so each
 * case starts from a clean one. An idle export with events still ahead is
 * the horizon held back by a transaction still open elsewhere on the
 * cluster: wait for it rather than call the business caught up.
 */
export async function drain(s: Schedules): Promise<void> {
  t.target.mode = 'ok';
  await ageLease(s, MAYBE_STORED_GAP);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- one batch after another
    if ((await exportFor(s)).kind === 'idle' && (await ahead(s)) === 0) return;
    // eslint-disable-next-line no-await-in-loop -- waiting out the horizon
    await sleep(50);
  }
  throw new Error('the export did not catch up');
}

/**
 * Runs out the business's export lease now, as time would (#963). The drain
 * runs out only the hold a gap whose body may have landed keeps: the
 * business's last gap has such a code and the lease is the one that gap's
 * own transaction wrote. Any other lease left behind still fails it.
 */
export async function ageLease(s: Schedules, onlyAfter?: string): Promise<void> {
  await rows(
    s,
    `update public.trace_export_cursors c
        set lease_until = clock_timestamp() - interval '1 second'
      where c.business_id = $1 and c.lease_holder is not null
        and ($2::text[] is null or exists (
              select 1 from (select g.code, g.recorded_at from public.trace_export_gaps g
                              where g.business_id = $1
                              order by g.recorded_at desc limit 1) last
               where last.code = any($2::text[])
                 and c.lease_until < last.recorded_at + interval '61 seconds'))`,
    [s.business, onlyAfter === undefined ? null : `{${onlyAfter}}`],
  );
}

async function ahead(s: Schedules, due = ''): Promise<number> {
  const found = await rows<{ n: string }>(
    t.alpha,
    `select count(*)::text as n from public.run_events ev
       left join public.trace_export_cursors c on c.business_id = ev.business_id
      where ev.business_id = $1
        and (c.after_tx is null or (ev.tx, ev.id) > (c.after_tx, c.after_id)) ${due}`,
    [s.business],
  );
  return Number(found[0]?.n);
}

export async function cursorOf(s: Schedules): Promise<string> {
  return JSON.stringify(
    await rows(
      t.alpha,
      'select after_tx::text, after_id from public.trace_export_cursors where business_id = $1',
      [s.business],
    ),
  );
}

/** The span ids in the bodies the target received. */
export function spanIds(bodies: readonly string[]): string[] {
  return bodies.flatMap((body) =>
    (
      JSON.parse(body) as {
        resourceSpans: { scopeSpans: { spans: { spanId: string }[] }[] }[];
      }
    ).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((sc) => sc.spans.map((sp) => sp.spanId))),
  );
}
