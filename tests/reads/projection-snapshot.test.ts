// SPDX-License-Identifier: AGPL-3.0-only
//
// One proposal read answers one state of the task (P2 at 3eddfbe).
//
// The read runs in an ordinary read-committed transaction, where each statement
// sees what was committed when it began. A gate read in one statement and the
// decisions read in a later one describe two moments: a `task.decide` that
// commits between them yields `gate.state = pending` beside a verified
// `approve` on that same gate, and the task page then offers to approve a
// version that is already approved. Every fact in that answer verifies; the
// answer as a whole describes no state the task ever held.
//
// So these cases assert a relation, not an absence of exceptions: for every
// gate in the answer, a decision on its round exists exactly when the gate
// reads the state that decision produced. A pending view carries no new
// decision, a decided view carries its decision, and nothing in between.
//
// The interleaving is forced. The read is handed its own transaction wrapped so
// that a real, correctly signed `task.decide` commits through the production
// command on another connection, before or after a numbered statement.
//
// Detection stays: a missing or tampered decision still fails the same read
// with `DECISION_INTEGRITY`.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ProposalView,
  readTaskProposals,
} from '../../packages/core-records/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-records/src/reads/verified-decisions.ts';
import { connect, type TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import type { SigningKey } from '../../packages/core-runtime/src/signing.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';

interface Proposed {
  readonly taskId: string;
  readonly gateId: string;
  readonly versionId: string;
  readonly lineageId: string;
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

async function propose(world: World, taskId: string, lineageId?: string): Promise<Proposed> {
  const proposed = await asAda(world, '/task/propose', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(world, taskId),
    purpose: 'draft_the_reply',
    maximumMinor: 1500,
    currency: 'AUD',
    payload: { instruction: 'draft a reply' },
    step: { kind: 'compose', payload: {} },
    ...(lineageId === undefined ? {} : { lineageId }),
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  return {
    taskId,
    gateId: String(detail['gateId']),
    versionId: String(detail['versionId']),
    lineageId: String(detail['lineageId']),
  };
}

async function decide(world: World, gate: Proposed, decision: string): Promise<void> {
  const answer = await asAda(world, '/task/decide', {
    operationId: randomUUID(),
    gateId: gate.gateId,
    versionId: gate.versionId,
    decision,
    note: `${decision} mid-read`,
  });
  expect(answer.code, `decide ${decision}`).toBe('ok');
}

/** A pending round-1 gate with no decision. */
async function pendingFirst(world: World): Promise<Proposed> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `one state per read ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  return await propose(world, String(created.body['recordId']));
}

/** A lineage whose round 1 was sent back, with its round-2 gate pending. */
async function pendingSecond(world: World): Promise<Proposed> {
  const first = await pendingFirst(world);
  await decide(world, first, 'request_changes');
  return await propose(world, first.taskId, first.lineageId);
}

function configuredKey(): SigningKey {
  return {
    id: process.env['GATE_SIGNING_KEY_ID'] ?? '',
    secret: process.env['GATE_SIGNING_SECRET'] ?? '',
  };
}

/** Where the decide commits: before statement `at` starts, or after it returns. */
type Pause = { readonly before: number } | { readonly after: number };

function pausing(
  tx: TenantQuery,
  pause: Pause,
  between: () => Promise<void>,
): { readonly tx: TenantQuery; readonly seen: () => number; readonly paused: () => boolean } {
  let count = 0;
  let paused = false;
  const wait = async (): Promise<void> => {
    paused = true;
    await between();
  };
  return {
    seen: () => count,
    paused: () => paused,
    tx: {
      businessId: tx.businessId,
      async query<Row>(text: string, parameters?: readonly unknown[]) {
        if ('before' in pause && count === pause.before) await wait();
        const rows = await tx.query<Row>(text, parameters);
        count += 1;
        if ('after' in pause && count === pause.after + 1) await wait();
        return rows;
      },
    },
  };
}

/** A read on its own connection: the world's application pool is one backend. */
async function onReader<T>(world: World, run: (tx: TenantQuery) => Promise<T>): Promise<T> {
  const reader = connect(world.db.appUrl, { source: 'runtime' });
  try {
    return await reader.withBusiness(world.alpha, run);
  } finally {
    await reader.close();
  }
}

const DECIDED: Readonly<Record<string, string>> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'changes_requested',
};

/**
 * Every gate whose state and decision disagree, as `gate: state beside
 * decision`. A gate and a decision belong together by round within a lineage,
 * since each round has one gate and at most one decision.
 */
function mixedPairs(view: readonly ProposalView[]): readonly string[] {
  const faults: string[] = [];
  for (const lineage of view) {
    for (const version of lineage.versions) {
      const gate = version.gate;
      if (gate === null) continue;
      const decision = lineage.decisions.find((row) => row.round === gate.round);
      const expected = decision === undefined ? undefined : DECIDED[decision.decision];
      const undecided = gate.state === 'pending' || gate.state === 'expired';
      if (decision === undefined ? !undecided : gate.state !== expected) {
        faults.push(`${gate.id}: ${gate.state} beside ${decision?.decision ?? 'no decision'}`);
      }
    }
  }
  return faults;
}

/** The gate the case decided, and its decision, as the answer gives them. */
function pairFor(view: readonly ProposalView[], gate: Proposed) {
  const lineage = view.find((row) => row.lineageId === gate.lineageId);
  const version = lineage?.versions.find((row) => row.versionId === gate.versionId);
  const round = version?.gate?.round;
  return {
    state: version?.gate?.state,
    decision: lineage?.decisions.find((row) => row.round === round)?.decision,
    decisions: lineage?.decisions.length ?? 0,
    reservations: lineage?.reservations.length ?? 0,
  };
}

describe.skipIf(serverUrl === undefined)('one proposal read, one state of the task', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  const rounds = [
    { name: 'the first decision', setup: pendingFirst, earlier: 0 },
    { name: 'a later round after Request Changes', setup: pendingSecond, earlier: 1 },
  ] as const;

  // Statement 0 is the read's first statement. A decide before it lands in
  // the snapshot; a decide after it does not, and must not leak in later.
  const pauses = [
    { pause: { before: 0 }, lands: true },
    { pause: { after: 0 }, lands: false },
    { pause: { after: 1 }, lands: false },
    { pause: { after: 2 }, lands: false },
  ] as const;

  for (const { name, setup, earlier } of rounds) {
    it(`answers ${name} as wholly pending or wholly decided, never a mix`, async () => {
      world = await createWorld('psnap');
      const current = world;
      for (const { pause, lands } of pauses) {
        // eslint-disable-next-line no-await-in-loop
        const gate = await setup(current);
        // eslint-disable-next-line no-await-in-loop
        const result = await onReader(current, async (tx) => {
          const wrapped = pausing(tx, pause, async () => await decide(current, gate, 'approve'));
          const view = await readTaskProposals(wrapped.tx, gate.taskId, configuredKey());
          return { view, paused: wrapped.paused(), seen: wrapped.seen() };
        });
        const at = JSON.stringify(pause);
        const pair = pairFor(result.view, gate);
        // The relation first, so a failure names the contradictory pair.
        expect(mixedPairs(result.view), `the answer with a decide ${at}`).toEqual([]);
        if (result.paused) {
          // Then which of the two coherent answers: the one the snapshot held.
          expect(pair, `the view with a decide ${at}`).toEqual(
            lands
              ? { state: 'approved', decision: 'approve', decisions: earlier + 1, reservations: 1 }
              : { state: 'pending', decision: undefined, decisions: earlier, reservations: 0 },
          );
        } else {
          // A pause after a statement the read never ran: the read held one
          // snapshot and the decide came after it, so the view is pending.
          expect(pair.state, `no pause at ${at}`).toBe('pending');
          // eslint-disable-next-line no-await-in-loop
          await decide(current, gate, 'approve');
        }

        // And the committed decision reads afterwards, whole.
        // eslint-disable-next-line no-await-in-loop
        const after = await current.db.app.withBusiness(current.alpha, async (tx) =>
          readTaskProposals(tx, gate.taskId, configuredKey()),
        );
        expect(mixedPairs(after)).toEqual([]);
        expect(pairFor(after, gate)).toEqual({
          state: 'approved',
          decision: 'approve',
          decisions: earlier + 1,
          reservations: 1,
        });
      }
    }, 180_000);
  }

  it('is one statement, so there is no gap for a decide to land in', async () => {
    world = await createWorld('psnap');
    const current = world;
    const gate = await pendingSecond(current);
    const seen = await onReader(current, async (tx) => {
      const wrapped = pausing(tx, { after: 99 }, () => Promise.resolve());
      await readTaskProposals(wrapped.tx, gate.taskId, configuredKey());
      return wrapped.seen();
    });
    expect(seen).toBe(1);
  }, 60_000);

  it('still fails a decided gate whose decision is missing or tampered', async () => {
    world = await createWorld('psnap');
    const current = world;
    const tamper = async (sql: string, gateId: string): Promise<void> => {
      await current.db.admin.execute('alter table public.gate_decisions disable trigger all');
      try {
        await current.db.admin.execute(sql, [current.alpha, gateId]);
      } finally {
        await current.db.admin.execute('alter table public.gate_decisions enable trigger all');
      }
    };
    const failureOf = async (taskId: string): Promise<unknown> => {
      try {
        await onReader(current, async (tx) => readTaskProposals(tx, taskId, configuredKey()));
        return null;
      } catch (cause) {
        return cause;
      }
    };

    const missing = await pendingSecond(current);
    await decide(current, missing, 'approve');
    await tamper(
      'delete from public.gate_decisions where business_id = $1 and gate_id = $2',
      missing.gateId,
    );
    const gone = await failureOf(missing.taskId);
    expect(gone).toBeInstanceOf(DecisionIntegrityError);
    expect((gone as DecisionIntegrityError).code).toBe('DECISION_INTEGRITY');
    expect((gone as Error).message).toMatch(/is approved and has no decision/u);

    // A fresh business chain for the tampered case, so the deletion above does
    // not answer for it.
    await current.close();
    world = await createWorld('psnap');
    const next = world;
    const tampered = await pendingFirst(next);
    await decide(next, tampered, 'approve');
    await next.db.admin.execute('alter table public.gate_decisions disable trigger all');
    try {
      await next.db.admin.execute(
        `update public.gate_decisions set evidence_digest = 'not-the-signed-digest'
          where business_id = $1 and gate_id = $2`,
        [next.alpha, tampered.gateId],
      );
    } finally {
      await next.db.admin.execute('alter table public.gate_decisions enable trigger all');
    }
    let failure: unknown = null;
    try {
      await next.db.app.withBusiness(next.alpha, async (tx) =>
        readTaskProposals(tx, tampered.taskId, configuredKey()),
      );
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(DecisionIntegrityError);
    expect((failure as DecisionIntegrityError).code).toBe('DECISION_INTEGRITY');
  }, 120_000);
});
