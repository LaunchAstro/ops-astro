// SPDX-License-Identifier: AGPL-3.0-only
//
// A pending gate past its deadline reads as expired (owner decision, 23 Sep 2026).
//
// Nathan's answer to "how should an approval gate that passes its deadline be
// represented" was: show expired on read, preserve the stored record. So these
// cases hold four things at once.
//
// - **The projection.** `task.read` draws a gate whose stored state is
//   `pending` and whose `expires_at <= now()` as `expired`. `now()` is the
//   database's own clock, read inside the statement that reads the gate.
// - **The stored record.** `gates.state` stays `pending`. Nothing writes
//   `expired`: no timer, no migration, and not the read.
// - **Decided outcomes.** An approved, rejected or sent-back gate keeps its
//   outcome after its deadline. Only an otherwise pending gate expires.
// - **The refusal.** A decide on the expired gate still answers 410
//   `GATE_EXPIRED` and writes no decision.
//
// **The deadline is crossed on the database clock.** Each gate is proposed
// through the production path with a short `expiresInSeconds`, and the cases
// wait until the database says the deadline has passed. No row is back-dated.
//
// **The boundary is inclusive**, the same operator as the decide path's
// refusal (`packages/core-runtime/src/decide.ts`, `(g.expires_at <= $3::timestamptz)`,
// the database clock read after its locks).
// A gate read at exactly its deadline reads expired, because a decide at
// that instant would be refused. A clock cannot be stopped on a stored
// microsecond, so the boundary case evaluates the read's own statement with
// its `now()` bound to the stored `expires_at`, and to one microsecond
// before it. That substitution only reads. Nothing is written.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';

/** Short enough to wait out, long enough to decide the decided ones first. */
const SHORT_SECONDS = 4;

interface Minted {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
}

interface GateRow {
  readonly state: string;
  readonly expires_at: string;
  readonly round: number;
}

const asAda = async (world: World, name: string, body: Readonly<Record<string, unknown>>) =>
  await call(world.api, personPath('alpha', name), body, bearer(world.ada.token));

async function revisionOf(world: World, recordId: string): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly revision: string }>(
    'select revision::text as revision from public.records where business_id = $1 and id = $2',
    [world.alpha, recordId],
  );
  return Number(rows[0]?.revision ?? '0');
}

/** A task and a proposal on it, through the production create and propose. */
async function mint(world: World, expiresInSeconds?: number): Promise<Minted> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a gate that meets its deadline ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  const taskId = String(created.body['recordId']);
  const proposed = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
    ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  return { taskId, gateId: String(detail['gateId']), versionId: String(detail['versionId']) };
}

async function decide(world: World, gate: Minted, decision: string) {
  return await asAda(world, '/task/decide', {
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    decision,
    note: `decided (${decision}) before the deadline`,
  });
}

/** The gate the task page is given, through `task.read` as the page reads it. */
async function gateOnRead(world: World, taskId: string): Promise<Record<string, unknown>> {
  const read = await asAda(world, '/task/read', { operationId: randomUUID(), recordId: taskId });
  expect(read.code, 'task.read').toBe('ok');
  const task = read.body['task'] as Record<string, unknown>;
  const proposals = task['proposals'] as readonly Record<string, unknown>[];
  const versions = proposals[0]?.['versions'] as readonly Record<string, unknown>[];
  return versions[0]?.['gate'] as Record<string, unknown>;
}

async function storedGate(world: World, gateId: string): Promise<GateRow> {
  const rows = await world.db.admin.execute<GateRow>(
    `select state, expires_at::text as expires_at, round
       from public.gates where business_id = $1 and id = $2`,
    [world.alpha, gateId],
  );
  return rows[0] as GateRow;
}

async function decisionCount(world: World): Promise<number> {
  const rows = await world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.gate_decisions where business_id = $1',
    [world.alpha],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Wait until the database's clock is past every named gate's deadline. */
async function waitOutOnDatabaseClock(world: World, gateIds: readonly string[]): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await world.db.admin.execute<{ readonly past: boolean }>(
      `select bool_and(expires_at < now()) as past
         from public.gates where business_id = $1 and id = any($2::uuid[])`,
      [world.alpha, gateIds],
    );
    if (rows[0]?.past === true) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the database clock never passed the deadlines');
}

/**
 * The read's own statement, with its `now()` bound to an instant the database
 * computes from the stored row. Read-only: it changes what the statement is
 * asked about, never a row.
 */
function atInstant(tx: TenantQuery, instantSql: string): TenantQuery {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
      return async (sql: string, params?: readonly unknown[]) =>
        await target.query(sql.replaceAll('now()', `(${instantSql})`), params as unknown[]);
    },
  });
}

/** The stored deadline, computed by the database from the row itself. */
const deadline = (gateId: string): string =>
  `select g0.expires_at from public.gates g0 where g0.id = '${gateId}'::uuid`;

if (serverUrl === undefined) {
  console.warn('reads/gate-expiry: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('a gate past its deadline, on read', () => {
  let world: World;
  let open: Minted;
  let lapsed: Minted;
  let approved: Minted;
  let rejected: Minted;
  let sentBack: Minted;

  beforeAll(async () => {
    world = await createWorld('gexp');
    open = await mint(world);
    lapsed = await mint(world, SHORT_SECONDS);
    approved = await mint(world, SHORT_SECONDS);
    rejected = await mint(world, SHORT_SECONDS);
    sentBack = await mint(world, SHORT_SECONDS);
    expect((await decide(world, approved, 'approve')).code).toBe('ok');
    expect((await decide(world, rejected, 'reject')).code).toBe('ok');
    expect((await decide(world, sentBack, 'request_changes')).code).toBe('ok');
    await waitOutOnDatabaseClock(world, [
      lapsed.gateId,
      approved.gateId,
      rejected.gateId,
      sentBack.gateId,
    ]);
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('reads a pending gate before its deadline as pending', async () => {
    const gate = await gateOnRead(world, open.taskId);
    expect(gate['state']).toBe('pending');
    expect(gate['expired']).toBe(false);
  });

  it('reads a pending gate after its deadline as expired, and the stored row stays pending', async () => {
    const before = await storedGate(world, lapsed.gateId);
    const decisions = await decisionCount(world);

    const gate = await gateOnRead(world, lapsed.taskId);
    expect(gate['state']).toBe('expired');
    expect(gate['expired']).toBe(true);

    // The read wrote nothing: the row is what it was, still `pending`.
    const after = await storedGate(world, lapsed.gateId);
    expect(after).toStrictEqual(before);
    expect(after.state).toBe('pending');
    expect(await decisionCount(world)).toBe(decisions);
  });

  it.each([
    ['approved', () => approved],
    ['rejected', () => rejected],
    ['changes_requested', () => sentBack],
  ] as const)('keeps a %s outcome after the deadline', async (outcome, which) => {
    const gate = await gateOnRead(world, which().taskId);
    expect(gate['state']).toBe(outcome);
    // `expired` is the projection's, and a decided gate is not expired.
    expect(gate['expired']).toBe(false);
    expect((await storedGate(world, which().gateId)).state).toBe(outcome);
  });

  it('still refuses a decide on the expired gate with 410 GATE_EXPIRED and writes no decision', async () => {
    const decisions = await decisionCount(world);
    const answer = await decide(world, lapsed, 'approve');
    expect([answer.status, answer.code]).toStrictEqual([410, 'GATE_EXPIRED']);
    expect(await decisionCount(world)).toBe(decisions);
    expect((await storedGate(world, lapsed.gateId)).state).toBe('pending');
    expect((await gateOnRead(world, lapsed.taskId))['state']).toBe('expired');
  });

  describe('the boundary: inclusive, as the decide refusal is', () => {
    const projectedAt = async (minted: Minted, instantSql: string) =>
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        const proposals = await readTaskProposals(atInstant(tx, instantSql), minted.taskId);
        return proposals[0]?.versions[0]?.gate;
      });

    it('reads a pending gate at exactly its deadline as expired', async () => {
      const gate = await projectedAt(lapsed, deadline(lapsed.gateId));
      expect([gate?.state, gate?.expired]).toStrictEqual(['expired', true]);
    });

    it('reads a pending gate one microsecond before its deadline as pending', async () => {
      const gate = await projectedAt(
        lapsed,
        `(${deadline(lapsed.gateId)}) - interval '1 microsecond'`,
      );
      expect([gate?.state, gate?.expired]).toStrictEqual(['pending', false]);
    });

    it('keeps a decided outcome at exactly its deadline', async () => {
      const gate = await projectedAt(approved, deadline(approved.gateId));
      expect([gate?.state, gate?.expired]).toStrictEqual(['approved', false]);
    });

    it('uses the same predicate as the decide refusal', () => {
      // A source check, so a change to either side's operator fails here
      // rather than letting the page and the refusal disagree at the instant.
      const decideSource = readFileSync(
        new URL('../../packages/core-runtime/src/decide.ts', import.meta.url),
        'utf8',
      );
      const readSource = readFileSync(
        new URL('../../packages/core-records/src/reads/proposals.ts', import.meta.url),
        'utf8',
      );
      expect(decideSource).toContain('(g.expires_at <= $3::timestamptz) as expired');
      expect(readSource).toContain("g.state = 'pending' and g.expires_at <= now()");
    });
  });
});
