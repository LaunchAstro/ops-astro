// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision committed while a proposal read is under way is a valid decision,
// and the read must say so (C1 at 6f15252).
//
// The read runs in an ordinary read-committed transaction, where each
// statement sees what was committed when it started. The integrity check
// compares the decision chain with what the gates and lineages say was
// decided, so the two have to come from one snapshot: a chain read before a
// `task.decide` commits and a gate read after it disagree about intact
// evidence, and the read would fault on a decision nobody touched.
//
// The interleaving is forced, not hoped for. The read is handed its own
// transaction wrapped so that, after the statement numbered `after`, it waits
// while a real, correctly signed `task.decide` commits through the production
// command on another connection. Nothing in the product changes for the test.
//
// Detection stays: a decision genuinely missing is still the named fault in
// the same read, paused or not.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import {
  DecisionIntegrityError,
  readVerifiedDecisions,
} from '../../packages/core-records/src/reads/verified-decisions.ts';
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

type Decision = 'approve' | 'reject' | 'request_changes';

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

async function createTask(world: World): Promise<string> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a decision mid-read ${randomUUID()}` },
  });
  expect(created.code, 'create').toBe('ok');
  return String(created.body['recordId']);
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

/** `task.decide` through the production command, committed before it returns. */
async function decide(world: World, gate: Proposed, decision: Decision): Promise<void> {
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
  return await propose(world, await createTask(world));
}

/** A lineage with one requested change behind it and its round-2 gate pending. */
async function pendingSecond(world: World): Promise<Proposed> {
  const first = await pendingFirst(world);
  await decide(world, first, 'request_changes');
  const second = await propose(world, first.taskId, first.lineageId);
  expect(second.lineageId).toBe(first.lineageId);
  return second;
}

function configuredKey(): SigningKey {
  return {
    id: process.env['GATE_SIGNING_KEY_ID'] ?? '',
    secret: process.env['GATE_SIGNING_SECRET'] ?? '',
  };
}

/**
 * The transaction, unchanged, except that after statement number `after`
 * returns it waits for `between` before handing the rows back. Returns the
 * statements it saw, so a case can show the pause really fell inside the read.
 */
function pausingAfter(
  tx: TenantQuery,
  after: number,
  between: () => Promise<void>,
): { readonly tx: TenantQuery; readonly seen: () => number; readonly paused: () => boolean } {
  let count = 0;
  let paused = false;
  return {
    seen: () => count,
    paused: () => paused,
    tx: {
      businessId: tx.businessId,
      async query<Row>(text: string, parameters?: readonly unknown[]) {
        const rows = await tx.query<Row>(text, parameters);
        count += 1;
        if (count === after + 1) {
          paused = true;
          await between();
        }
        return rows;
      },
    },
  };
}

/**
 * A read on a connection of its own. The world's application pool is one
 * backend, so a read holding it would leave the decide nowhere to run.
 */
async function onReader<T>(world: World, run: (tx: TenantQuery) => Promise<T>): Promise<T> {
  const reader = connect(world.db.appUrl, { source: 'runtime' });
  try {
    return await reader.withBusiness(world.alpha, run);
  } finally {
    await reader.close();
  }
}

/** What a promise rejected with, or `null` if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (cause) {
    return cause;
  }
}

async function tamper(world: World, sql: string, params: readonly unknown[]): Promise<void> {
  await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
  try {
    await world.db.admin.execute(sql, params as unknown[]);
  } finally {
    await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
  }
}

describe.skipIf(serverUrl === undefined)('a decision committed during the decision read', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  const cases = [
    { name: 'the first decision on a pending gate', setup: pendingFirst, before: 0 },
    { name: 'a later decision on a lineage that has one', setup: pendingSecond, before: 1 },
  ] as const;

  for (const { name, setup, before } of cases) {
    it(`reads ${name} as a valid old or new view, never DECISION_INTEGRITY`, async () => {
      world = await createWorld('dsnap');
      const current = world;
      const gate = await setup(current);
      const paused = await onReader(current, async (tx) => {
        const pausing = pausingAfter(tx, 0, async () => await decide(current, gate, 'approve'));
        let rows: readonly { readonly gate_id: string; readonly decision: string }[] = [];
        const outcome = await rejectionOf(
          (async () => {
            rows = await readVerifiedDecisions(pausing.tx, [gate.lineageId], configuredKey());
          })(),
        );
        return { outcome, rows, paused: pausing.paused() };
      });
      // An old view has the decisions from before; a new one has the approval too.
      expect([before, before + 1]).toContain(paused.rows.length);
      if (paused.rows.length === before + 1) {
        expect(paused.rows.at(-1)?.gate_id).toBe(gate.gateId);
        expect(paused.rows.at(-1)?.decision).toBe('approve');
      }
      expect(paused.paused, 'the decide committed inside the read').toBe(true);
      expect(paused.outcome).toBeNull();

      // And the committed decision reads afterwards, verified.
      const after = await current.db.app.withBusiness(current.alpha, async (tx) =>
        readVerifiedDecisions(tx, [gate.lineageId], configuredKey()),
      );
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)?.decision).toBe('approve');
    }, 60_000);
  }

  it('reads the proposal projection whichever statement the decide lands after', async () => {
    world = await createWorld('dsnap');
    const current = world;
    // The projection is one statement now, the decision read's own
    // (`projection-snapshot.test.ts` holds its relational cases). A decide
    // after it leaves a valid view.
    for (const after of [0]) {
      // eslint-disable-next-line no-await-in-loop
      const gate = await pendingFirst(current);
      // eslint-disable-next-line no-await-in-loop
      const result = await onReader(current, async (tx) => {
        const pausing = pausingAfter(tx, after, async () => await decide(current, gate, 'approve'));
        const outcome = await rejectionOf(readTaskProposals(pausing.tx, gate.taskId));
        return { outcome, paused: pausing.paused() };
      });
      expect(result.paused, `a pause after statement ${after}`).toBe(true);
      expect(result.outcome, `a decide after statement ${after}`).toBeNull();
    }
  }, 120_000);

  it('still fails a decided gate whose decision is genuinely missing, paused or not', async () => {
    world = await createWorld('dsnap');
    const current = world;
    const gate = await pendingSecond(current);
    await decide(current, gate, 'approve');
    // The newest decision removed: the shorter chain verifies from genesis, and
    // the approved round-2 gate is what shows it is gone.
    await tamper(
      current,
      `delete from public.gate_decisions where business_id = $1 and gate_id = $2`,
      [current.alpha, gate.gateId],
    );
    for (const after of [0, 1]) {
      // eslint-disable-next-line no-await-in-loop
      const failure = await rejectionOf(
        onReader(current, async (tx) => {
          const pausing = pausingAfter(tx, after, () => Promise.resolve());
          return await readVerifiedDecisions(pausing.tx, [gate.lineageId], configuredKey());
        }),
      );
      expect(failure).toBeInstanceOf(DecisionIntegrityError);
      expect((failure as Error).message).toMatch(/is approved and has no decision/u);
    }
  }, 60_000);
});
