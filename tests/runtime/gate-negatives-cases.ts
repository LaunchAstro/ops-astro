// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the gate negatives run in, and the one question every negative
// asks after its refusal: did anything move?
//
// Everything is built through the real command envelope. A proposal is a
// `task.propose`, a decision is a `task.decide`, and a comment is a
// `task.comment`, so a refusal below is the refusal a caller would get and
// its audit row is the row the caller's attempt leaves. The only writes that
// bypass the product are the tampers, and they are what the negatives are
// about: a gate or pack that the proposal writer would never produce, made by
// the owner role the way corruption or a hand-inserted fixture would make it.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { FreshDatabase } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/tenancy/database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';

export const CAP_LIMIT_MINOR = 100_000;

export interface Proposal {
  readonly lineageId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly evidencePackId: string;
  readonly gateId: string;
}

export interface GateWorld {
  readonly db: FreshDatabase;
  readonly business: BusinessId;
  readonly decider: Member;
  /** Every call goes through `executeCommand` on `on`, the fixture's pool unless a rival is named. */
  call(body: Readonly<Record<string, unknown>>, on?: Database): Promise<CommandResult>;
  createTask(title: string): Promise<string>;
  propose(recordId: string, lineageId?: string): Promise<Proposal>;
  decideBody(
    of: Pick<Proposal, 'gateId' | 'versionId'>,
    decision: 'approve' | 'reject' | 'request_changes',
    operationId?: string,
  ): Readonly<Record<string, unknown>>;
  comment(recordId: string, body: string): Promise<void>;
  auditFor(
    operationId: string,
  ): Promise<readonly { outcome: string; refusal_code: string | null }[]>;
  snapshot(gateId: string): Promise<Snapshot>;
}

/** A business with a decider holding the five actions and a finite synthetic cap. */
export async function buildGateWorld(db: FreshDatabase, key: string): Promise<GateWorld> {
  const business = (await insertBusiness(db.app, key)) as BusinessId;
  await installSpine(db.app, business);
  const decider = await enrol(db.app, business, 'decider');
  await db.app.withBusiness(business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // Sequential: `issueGrant` reads the granter's own rows, so two at once
      // would interleave those reads.
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, decider, action);
    }
    await tx.query(
      `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
       values ($1, $2, 'local', $3, 'AUD')`,
      [business, randomUUID(), CAP_LIMIT_MINOR],
    );
  });

  async function call(
    body: Readonly<Record<string, unknown>>,
    on: Database = db.app,
  ): Promise<CommandResult> {
    return await executeCommand(on, business, decider.presented, 'api', body as never);
  }

  async function revisionOf(recordId: string): Promise<number> {
    const detail = (await executeRead(db.app, business, decider.presented, {
      read: 'task.read',
      recordId,
    })) as unknown as { readonly task: { readonly revision: number } };
    return detail.task.revision;
  }

  return {
    db,
    business,
    decider,
    call,
    async createTask(title) {
      const outcome = await call({
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title },
      });
      if (isCommandRefusal(outcome)) throw new Error(`task.create refused ${outcome.code}`);
      if (outcome.recordId === null) throw new Error('task.create returned no record');
      return outcome.recordId;
    },
    async propose(recordId, lineageId) {
      const outcome = await call({
        command: 'task.propose',
        operationId: randomUUID(),
        recordId,
        expectedRevision: await revisionOf(recordId),
        purpose: 'draft_the_reply',
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'draft a reply to the client' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
        ...(lineageId === undefined ? {} : { lineageId }),
      });
      if (isCommandRefusal(outcome)) throw new Error(`task.propose refused ${outcome.code}`);
      return outcome.detail as unknown as Proposal;
    },
    decideBody(of, decision, operationId = randomUUID()) {
      return {
        command: 'task.decide',
        operationId,
        gateId: of.gateId,
        versionId: of.versionId,
        decision,
        note: decision,
      };
    },
    async comment(recordId, body) {
      const outcome = await call({
        command: 'task.comment',
        operationId: randomUUID(),
        recordId,
        expectedRevision: await revisionOf(recordId),
        body,
        audience: 'internal',
      });
      if (isCommandRefusal(outcome)) throw new Error(`task.comment refused ${outcome.code}`);
    },
    async auditFor(operationId) {
      return await db.app.withBusiness(business, async (tx) =>
        (await readAuditEvents(tx)).filter((event) => event.operation_id === operationId),
      );
    },
    async snapshot(gateId) {
      return await snapshotOf(db, business, gateId);
    },
  };
}

/**
 * Everything a refused decision could have half-written: the decision chain,
 * the money, the work, the plan and the gate itself. Counts are business-wide
 * so a write to the wrong row is caught as surely as a write to the right one.
 */
export interface Snapshot {
  readonly counts: Readonly<Record<string, number>>;
  readonly chainHead: string | null;
  readonly gate: {
    readonly state: string;
    readonly round: number;
    readonly decided_at: Date | null;
  };
  readonly envelopeHeld: string | null;
}

const COUNTED = [
  'gates',
  'gate_decisions',
  'reservations',
  'attempts',
  'leases',
  'task_envelopes',
  'proposal_lineages',
  'proposal_versions',
  'planned_runs',
  'planned_steps',
  'evidence_packs',
] as const;

export async function snapshotOf(
  db: FreshDatabase,
  business: string,
  gateId: string,
): Promise<Snapshot> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.${table} where business_id = $1`,
      [business],
    );
    counts[table] = Number(rows[0]?.n ?? '0');
  }
  const heads = await db.admin.execute<{ readonly head: string | null }>(
    `select max(seq)::text as head from public.gate_decisions where business_id = $1`,
    [business],
  );
  const gates = await db.admin.execute<{
    readonly state: string;
    readonly round: number;
    readonly decided_at: Date | null;
  }>(`select state, round, decided_at from public.gates where business_id = $1 and id = $2`, [
    business,
    gateId,
  ]);
  const held = await db.admin.execute<{ readonly held: string | null }>(
    `select sum(held_minor)::text as held from public.task_envelopes where business_id = $1`,
    [business],
  );
  const gate = gates[0];
  if (gate === undefined) throw new Error(`no gate ${gateId}`);
  return {
    counts,
    chainHead: heads[0]?.head ?? null,
    gate,
    envelopeHeld: held[0]?.held ?? null,
  };
}

/** The refusal is typed, it is on the trail, and nothing else moved. */
export async function expectRefusedWithoutEffect(
  world: GateWorld,
  outcome: CommandResult,
  code: string,
  operationId: string,
  before: Snapshot,
  gateId: string,
): Promise<void> {
  expect(isCommandRefusal(outcome) ? outcome.code : 'applied').toBe(code);
  const events = await world.auditFor(operationId);
  expect(events.map((event) => [event.outcome, event.refusal_code])).toStrictEqual([
    ['refused', code],
  ]);
  expect(await world.snapshot(gateId)).toStrictEqual(before);
}

/** What `pg` reports when the server refuses a statement, reduced to what the negatives compare. */
export async function sqlRefusal(statement: Promise<unknown>): Promise<{
  readonly code: string;
  readonly constraint: string | null;
  readonly column: string | null;
}> {
  try {
    await statement;
  } catch (error) {
    const failure = error as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      column_name?: string;
      column?: string;
    };
    return {
      code: failure.code ?? 'unknown',
      constraint: failure.constraint_name ?? failure.constraint ?? null,
      column: failure.column_name ?? failure.column ?? null,
    };
  }
  return { code: 'accepted', constraint: null, column: null };
}

export function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Ask the server how many backends are parked on a lock, rather than sleeping and hoping. */
export async function awaitWaiters(db: FreshDatabase, waiters: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.admin.execute<{ readonly waiting: string }>(
      `select count(*)::text as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(rows[0]?.waiting ?? 0) >= waiters) return;
    // eslint-disable-next-line no-await-in-loop
    await delay(25);
  }
  throw new Error(
    `fewer than ${waiters} backends ever blocked on a lock: the race was not established`,
  );
}
