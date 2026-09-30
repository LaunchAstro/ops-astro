// SPDX-License-Identifier: AGPL-3.0-only
//
// C54 against Postgres, through the page's own OperationsClient (apps/web)
// bound to the real API: the pane's run story reads the real task read, and
// the acts it sends land on the real commands.
// - `C54 refusal billing:decide`: a member without `billing:decide` is refused
//   each act, and nothing moves: no hold, no envelope, no applied event.
// - `C54 audit readback`: each act (the three outcomes, the write-off, the
//   top-up) reads its applied event back, by the operation id the client sent,
//   on an intact chain; the pane's story leaves unknown-outcome after its word.
// - `C54 top-up approver`: the plan's approver alone under the band; above it,
//   two approvers at once pair exactly once, two second approvers at once
//   apply exactly once, and a failed attempt applies nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStories } from '../../packages/ui/src/state/agent-run.ts';
import type { RunLineage } from '../../packages/ui/src/state/run-projection.ts';
import { isRefusal, isUnavailable } from '../../apps/web/src/operations/client.ts';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createWorld, serverUrl, tokenFor, type World } from '../acceptance/world.ts';
import {
  auditOf,
  billingHolder,
  holdOf,
  maximumOf,
  pageClient,
  plannedTask,
  setBand,
  signed,
  unknownWork,
  type Signed,
  type UnknownWork,
} from './c54-fixture.ts';

const REASON = 'The provider never answered; its statement shows no charge.';
/** The role-case proposal's maximum. */
const MAXIMUM = 3_000;
/** Under the shipped band of 500 (50 000 minor units), and above it. */
const SMALL = 1_000;
const LARGE = 60_000;

interface Sent {
  readonly status: number;
  readonly code: string;
  readonly state: unknown;
}

/** One act through the page's client, as `who`, with a known operation id. */
async function send(
  world: World,
  who: Signed,
  name: CommandName,
  body: Readonly<Record<string, unknown>>,
  operationId?: string,
): Promise<Sent> {
  let status = 0;
  const client = pageClient(world, who, (seen) => {
    status = seen;
  });
  const result = await client.mutate(name as never, body, {
    operationId: operationId ?? client.newOperationId(),
  });
  if (isUnavailable(result)) throw new Error(`c54: ${name} unreachable`);
  if (isRefusal(result)) return { status, code: result.code, state: undefined };
  return { status, code: 'ok', state: result.value.detail?.['state'] };
}

/** The pane's current story on the real read, as `who` sees it. */
async function storyOf(world: World, who: Signed, taskId: string) {
  const read = await pageClient(world, who).read<{ task: { proposals: RunLineage[] } }>(
    'task.read',
    { recordId: taskId },
  );
  if (isRefusal(read) || isUnavailable(read)) throw new Error('c54: task.read refused');
  return runStories(read.value.task.proposals).at(-1);
}

/** One act by `who` through the page's client, its applied event read back and the pane's reread. */
async function readBack(
  world: World,
  who: Signed,
  name: CommandName,
  target: UnknownWork | string,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  const taskId = typeof target === 'string' ? target : target.taskId;
  const operationId = crypto.randomUUID();
  const sent = await send(world, who, name, body, operationId);
  expect([name, sent.code]).toStrictEqual([name, 'ok']);
  expect(await auditOf(world, taskId, name)).toEqual([
    expect.objectContaining({
      actor_id: who.actorId,
      command: name,
      operation_id: operationId,
      outcome: 'applied',
      subject_record_id: taskId,
      hash: expect.stringMatching(/\S/u),
    }),
  ]);
  if (typeof target !== 'string') {
    // The pane's word is heard: the reread no longer holds the effect unknown.
    expect((await storyOf(world, who, taskId))?.unknownAttempt).toBeNull();
  }
}

const writeOff = (work: UnknownWork, amountMinor: number) => ({
  recordId: work.taskId,
  attemptId: work.attemptId,
  amountMinor,
  reason: REASON,
});

// eslint-disable-next-line max-lines-per-function -- one world, each act and its record
describe.skipIf(serverUrl === undefined)('C54 run money', { timeout: 60_000 }, () => {
  let world: World;
  let ada: Signed;
  let mia: Signed;
  let bob: Signed;
  let cai: Signed;

  beforeAll(async () => {
    world = await createWorld('c54_money');
    ada = signed(world.ada);
    mia = signed(world.mia);
    bob = await billingHolder(world, world.alpha, 'alpha', 'bob');
    cai = await billingHolder(world, world.alpha, 'alpha', 'cai');
  }, 240_000);

  afterAll(async () => await world?.close());

  it('C54 refusal billing:decide: a member without it is refused each act, and nothing moves', async () => {
    const work = await unknownWork(world, ada);
    const before = await holdOf(world, work.attemptId);
    const acts: [CommandName, Record<string, unknown>][] = [
      [
        'budget.record_outcome',
        { recordId: work.taskId, attemptId: work.attemptId, outcome: 'happened' },
      ],
      ['budget.write_off', writeOff(work, 0)],
      ['budget.top_up', { recordId: work.taskId, amountMinor: SMALL, fromMaximumMinor: MAXIMUM }],
    ];
    for (const [name, body] of acts) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await send(world, mia, name, body);
      expect([name, refused.status, refused.code]).toStrictEqual([name, 403, 'SCOPE_NOT_GRANTED']);
      // eslint-disable-next-line no-await-in-loop
      const applied = (await auditOf(world, work.taskId, name)).filter(
        (event) => event['outcome'] === 'applied',
      );
      expect(applied).toStrictEqual([]);
    }
    expect(await holdOf(world, work.attemptId)).toStrictEqual(before);
    // The stop stays: the pane still reads the effect as unknown.
    expect((await storyOf(world, mia, work.taskId))?.unknownAttempt?.id).toBe(work.attemptId);
  });

  it('C54 audit readback: each act reads its applied event back on an intact chain', async () => {
    const acts: [UnknownWork | string, CommandName, (target: never) => Record<string, unknown>][] =
      [];
    for (const outcome of ['nothing_happened', 'happened', 'happened_differently']) {
      // Sequential: each unknown effect made, then read as the pane reads it.
      // eslint-disable-next-line no-await-in-loop
      const work = await unknownWork(world, ada);
      // eslint-disable-next-line no-await-in-loop
      expect((await storyOf(world, ada, work.taskId))?.unknownAttempt?.id).toBe(work.attemptId);
      acts.push([
        work,
        'budget.record_outcome',
        (w: UnknownWork) => ({ recordId: w.taskId, attemptId: w.attemptId, outcome }),
      ]);
    }
    const toWriteOff = await unknownWork(world, ada);
    const toTopUp = await plannedTask(world, ada);
    acts.push(
      [toWriteOff, 'budget.write_off', (w: UnknownWork) => writeOff(w, 0)],
      [
        toTopUp,
        'budget.top_up',
        (taskId: string) => ({ recordId: taskId, amountMinor: SMALL, fromMaximumMinor: MAXIMUM }),
      ],
    );
    for (const [target, name, bodyOf] of acts) {
      // Sequential: each act's record read back before the next is sent.
      // eslint-disable-next-line no-await-in-loop
      await readBack(world, ada, name, target, bodyOf(target as never));
    }
    const chain = await world.db.app.withBusiness(world.alpha, verifyAuditChain);
    expect(chain).toMatchObject({ intact: true, firstBreak: undefined });
  });

  it('C54 top-up approver: the plan’s approver alone under the band', async () => {
    const taskId = await plannedTask(world, ada);
    const sent = await send(world, ada, 'budget.top_up', {
      recordId: taskId,
      amountMinor: SMALL,
      fromMaximumMinor: MAXIMUM,
    });
    expect([sent.code, sent.state]).toStrictEqual(['ok', 'applied']);
    expect(await maximumOf(world, taskId)).toBe(MAXIMUM + SMALL);
  });

  it('C54 top-up approver: a budget holder when the plan’s approver holds none, and never over one who does', async () => {
    // Dan approves plans and holds no budget permission: any holder tops up his.
    const dan = await enrol(world.db.app, world.alpha, 'dan');
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      for (const action of ['read', 'write', 'decide'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, dan, action);
      }
    });
    const dans = await plannedTask(world, {
      ...dan,
      token: await tokenFor(dan.presented.subject),
      businessKey: 'alpha',
    });
    const body = (taskId: string, amountMinor: number) => ({
      recordId: taskId,
      amountMinor,
      fromMaximumMinor: MAXIMUM,
    });
    const byHolder = await send(world, bob, 'budget.top_up', body(dans, SMALL));
    expect([byHolder.code, byHolder.state]).toStrictEqual(['ok', 'applied']);
    // Ada's plan: she holds budget permission, so another holder is refused and nothing moves.
    const adas = await plannedTask(world, ada);
    const operationId = crypto.randomUUID();
    const refused = await send(world, bob, 'budget.top_up', body(adas, SMALL), operationId);
    expect([refused.status, refused.code]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(await maximumOf(world, adas)).toBe(MAXIMUM);
    // A refusal is recorded as one, and nothing is applied.
    expect(await auditOf(world, adas, 'budget.top_up')).toHaveLength(0);
    expect(
      await world.db.admin.execute(
        `select outcome, refusal_code from public.audit_events where operation_id = $1`,
        [operationId],
      ),
    ).toEqual([{ outcome: 'refused', refusal_code: 'SCOPE_NOT_GRANTED' }]);
  });

  it('C54 top-up approver: above the band, the approver and a second holder at once move it at most once', async () => {
    const taskId = await plannedTask(world, ada);
    const body = { recordId: taskId, amountMinor: LARGE, fromMaximumMinor: MAXIMUM };
    const [first, second] = await Promise.all([
      send(world, ada, 'budget.top_up', body),
      send(world, bob, 'budget.top_up', body),
    ]);
    expect([first?.code, first?.state]).toStrictEqual(['ok', 'awaiting_second_approver']);
    // Bob's either pairs after ada's first approval commits, or comes first and is refused.
    const paired = second?.code === 'ok';
    expect(paired ? second.state : second?.code).toBe(paired ? 'applied' : 'SCOPE_NOT_GRANTED');
    expect(await maximumOf(world, taskId)).toBe(paired ? MAXIMUM + LARGE : MAXIMUM);
  });

  it('C54 top-up approver: two second approvers at once apply exactly once; the other applies nothing', async () => {
    const taskId = await plannedTask(world, ada);
    const body = { recordId: taskId, amountMinor: LARGE, fromMaximumMinor: MAXIMUM };
    const first = await send(world, ada, 'budget.top_up', body);
    expect([first.code, first.state]).toStrictEqual(['ok', 'awaiting_second_approver']);
    expect(await maximumOf(world, taskId)).toBe(MAXIMUM);
    const seconds = await Promise.all([
      send(world, bob, 'budget.top_up', body),
      send(world, cai, 'budget.top_up', body),
    ]);
    expect(seconds.map((sent) => sent.code).toSorted()).toStrictEqual(['VERSION_STALE', 'ok']);
    expect(seconds.find((sent) => sent.code === 'ok')?.state).toBe('applied');
    expect(await maximumOf(world, taskId)).toBe(MAXIMUM + LARGE);
    const applied = (await auditOf(world, taskId, 'budget.top_up')).filter(
      (event) => event['outcome'] === 'applied',
    );
    // The first approval and the one pairing: never a third.
    expect(applied).toHaveLength(2);
  });

  it('C54 top-up approver: the band is read at decision time, and a failed attempt applies nothing', async () => {
    const taskId = await plannedTask(world, ada);
    const body = { recordId: taskId, amountMinor: SMALL, fromMaximumMinor: MAXIMUM };
    // The band lowered after the page read: the same small top-up now needs two.
    await setBand(world, world.alpha, '5');
    try {
      const first = await send(world, ada, 'budget.top_up', body);
      expect([first.code, first.state]).toStrictEqual(['ok', 'awaiting_second_approver']);
      expect(await maximumOf(world, taskId)).toBe(MAXIMUM);
      // The same person twice is one pair of eyes, and a stale figure is refused: neither moves it.
      expect((await send(world, ada, 'budget.top_up', body)).code).toBe('FOUR_EYES_REQUIRED');
      const stale = { ...body, fromMaximumMinor: MAXIMUM - 1 };
      expect((await send(world, bob, 'budget.top_up', stale)).code).toBe('VERSION_STALE');
      expect(await maximumOf(world, taskId)).toBe(MAXIMUM);
      const paired = await send(world, bob, 'budget.top_up', body);
      expect([paired.code, paired.state]).toStrictEqual(['ok', 'applied']);
      expect(await maximumOf(world, taskId)).toBe(MAXIMUM + SMALL);
    } finally {
      await setBand(world, world.alpha, '500');
    }
  });
});
