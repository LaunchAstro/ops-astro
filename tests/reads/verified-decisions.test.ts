// SPDX-License-Identifier: AGPL-3.0-only
//
// The proposal read verifies every decision it returns (G02, T2).
//
// A decision is a signed, append-only row, and the task page shows it as the
// record of what somebody approved. So the read that hands it to the page
// checks it first, against the bytes the database holds:
//
// - **the payload** is recomputed into its digest, so altered content paired
//   with its old digest, signature and hash is caught (R9);
// - **the signature** is checked against the deployment's key;
// - **the link** is walked along the business's whole chain from genesis, not
//   only along the rows of one lineage, so a removed or rewritten decision on
//   another task breaks the reads that come after it.
//
// A failure is `DecisionIntegrityError`, and the HTTP answer carries no task:
// a read that returned the proposal anyway would be the page showing a
// tampered decision as a decided one.
//
// **The tamper is applied as the database owner**, with the append-only
// triggers disabled for the one statement. That is the restored-or-imported
// evidence case, and the application role cannot do it at all (see
// `tests/runtime/gate.test.ts`). Each tamper gets its own world, so one
// broken chain does not leak into the next case.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { readTaskProposals } from '../../packages/core-records/src/reads/proposals.ts';
import { DecisionIntegrityError } from '../../packages/core-records/src/reads/verified-decisions.ts';
import {
  bearer,
  call,
  createWorld,
  personPath,
  serverUrl,
  type World,
} from '../acceptance/world.ts';

interface Decided {
  readonly taskId: string;
  readonly gateId: string;
}

interface StoredLink {
  readonly id: string;
  readonly seq: string;
  readonly prev_hash: string;
  readonly hash: string;
  readonly signature: string;
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

/** A task, a proposal on it and an approval, all through the production path. */
async function decided(world: World): Promise<Decided> {
  const created = await asAda(world, '/task/create', {
    operationId: randomUUID(),
    fields: { title: `a decision worth checking ${randomUUID()}` },
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
  });
  expect(proposed.code, 'propose').toBe('ok');
  const detail = proposed.body['detail'] as Record<string, string>;
  const gateId = String(detail['gateId']);
  const approved = await asAda(world, '/task/decide', {
    operationId: randomUUID(),
    gateId,
    versionId: String(detail['versionId']),
    decision: 'approve',
    note: 'approved as proposed',
  });
  expect(approved.code, 'decide').toBe('ok');
  return { taskId, gateId };
}

async function readTask(world: World, taskId: string) {
  return await asAda(world, '/task/read', { operationId: randomUUID(), recordId: taskId });
}

async function storedLinks(world: World): Promise<readonly StoredLink[]> {
  return await world.db.admin.execute<StoredLink>(
    `select id, seq::text as seq, prev_hash, hash, signature
       from public.gate_decisions where business_id = $1 order by seq`,
    [world.alpha],
  );
}

/** One statement as the owner, with the append-only triggers off for it alone. */
async function tamper(world: World, sql: string, params: readonly unknown[]): Promise<void> {
  await world.db.admin.execute('alter table public.gate_decisions disable trigger all');
  try {
    await world.db.admin.execute(sql, params as unknown[]);
  } finally {
    await world.db.admin.execute('alter table public.gate_decisions enable trigger all');
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

/** The production read, called directly, so the named failure can be inspected. */
async function readDirect(world: World, taskId: string) {
  return await world.db.app.withBusiness(
    world.alpha,
    async (tx) => await readTaskProposals(tx, taskId),
  );
}

async function expectIntegrityFailure(world: World, taskId: string, where: RegExp) {
  const answer = await readTask(world, taskId);
  // A fault, not a refusal and not a success: no task, no proposals.
  expect(answer.status).toBeGreaterThanOrEqual(500);
  expect(answer.body['task']).toBeUndefined();
  expect(answer.body['ok']).toBeUndefined();

  const failure = await rejectionOf(readDirect(world, taskId));
  expect(failure).toBeInstanceOf(DecisionIntegrityError);
  const named = failure as DecisionIntegrityError;
  expect(named.code).toBe('DECISION_INTEGRITY');
  expect(named.message).toMatch(where);
}

if (serverUrl === undefined) {
  console.warn('reads/verified-decisions: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('a decision on read is verified', () => {
  let world: World | undefined;

  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  it('returns untampered decisions as stored, hash and signature unchanged', async () => {
    world = await createWorld('vread');
    const first = await decided(world);
    const second = await decided(world);
    const stored = await storedLinks(world);
    expect(stored).toHaveLength(2);

    for (const [index, task] of [first, second].entries()) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await readTask(world, task.taskId);
      expect(answer.code, 'task.read').toBe('ok');
      const proposals = (answer.body['task'] as Record<string, unknown>)['proposals'] as readonly {
        readonly decisions: readonly Record<string, unknown>[];
      }[];
      const link = stored[index] as StoredLink;
      expect(proposals[0]?.decisions).toHaveLength(1);
      expect(proposals[0]?.decisions[0]).toMatchObject({
        id: link.id,
        seq: Number(link.seq),
        prevHash: link.prev_hash,
        hash: link.hash,
        signature: link.signature,
      });
    }
  }, 60_000);

  it('fails a read whose decision payload was altered under its stored digest', async () => {
    world = await createWorld('vread');
    const task = await decided(world);
    await tamper(
      world,
      `update public.gate_decisions
          set payload = jsonb_set(payload, '{note}', '"approved for something else"')
        where business_id = $1 and gate_id = $2`,
      [world.alpha, task.gateId],
    );
    await expectIntegrityFailure(world, task.taskId, /seq 1: payload does not match/u);
  }, 60_000);

  it('fails a read whose chain link was rewritten', async () => {
    world = await createWorld('vread');
    await decided(world);
    const second = await decided(world);
    await tamper(
      world,
      `update public.gate_decisions set prev_hash = $3
        where business_id = $1 and gate_id = $2`,
      [world.alpha, second.gateId, 'f'.repeat(64)],
    );
    await expectIntegrityFailure(world, second.taskId, /seq 2: prev_hash does not follow/u);
  }, 60_000);

  it('walks the business chain: a removed decision on another task fails the later read', async () => {
    world = await createWorld('vread');
    const earlier = await decided(world);
    const later = await decided(world);
    await tamper(
      world,
      'delete from public.gate_decisions where business_id = $1 and gate_id = $2',
      [world.alpha, earlier.gateId],
    );
    // The later task's own lineage is untouched: its one decision is intact
    // and a per-lineage walk from its own first row would have nothing to
    // compare. Only the business chain knows what came before it.
    await expectIntegrityFailure(world, later.taskId, /seq 2: prev_hash does not follow/u);
  }, 60_000);

  it('fails rather than returns unverified decisions when no key is configured or the key differs', async () => {
    world = await createWorld('vread');
    const task = await decided(world);
    const unkeyed = await rejectionOf(
      world.db.app.withBusiness(
        world.alpha,
        async (tx) => await readTaskProposals(tx, task.taskId, null),
      ),
    );
    expect(unkeyed).toBeInstanceOf(DecisionIntegrityError);
    expect((unkeyed as Error).message).toMatch(/no signing key/u);

    const foreign = await rejectionOf(
      world.db.app.withBusiness(
        world.alpha,
        async (tx) =>
          await readTaskProposals(tx, task.taskId, {
            id: process.env['GATE_SIGNING_KEY_ID'] ?? '',
            secret: randomUUID(),
          }),
      ),
    );
    expect(foreign).toBeInstanceOf(DecisionIntegrityError);
    expect((foreign as Error).message).toMatch(/seq 1: signature does not verify/u);
  }, 60_000);

  it('leaves the stored evidence as it was: verifying is read-only', async () => {
    world = await createWorld('vread');
    const task = await decided(world);
    const before = await storedLinks(world);
    expect((await readTask(world, task.taskId)).code).toBe('ok');
    expect(await storedLinks(world)).toStrictEqual(before);
  }, 60_000);
});
