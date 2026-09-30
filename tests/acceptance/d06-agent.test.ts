// SPDX-License-Identifier: AGPL-3.0-only
//
// D06 on the agent prefix, generated the same way as `d06-generated.test.ts`.
//
// The agent's own operations are `AGENT_SURFACE`, and each has a real positive
// control here: the queue before any pickup, a pickup of a freshly approved
// reservation, and a read, a comment, a heartbeat, a check, the capabilities read and a
// handback under the credential that pickup handed out. Each is sent once
// valid, then again with every classified system-owned field, and the contract
// outcome is asserted: `FIELD_NOT_WRITABLE` naming the field, every other table
// unchanged, one refused audit row. Authority review finding 2 found the agent
// envelope never runs the classifier, so at the reviewed milestone these cells
// are red by design and stay unskipped: the correction lands in the envelope,
// and these are its regression.
//
// Every other declared operation is not the agent's to call. Those cells are
// still sent with the field and still asserted refused with nothing moved; the
// code they answer is the envelope's exclusion, and which of the two refusals
// comes first is the envelope's decision, so only "refused and unchanged" is
// asserted for them.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_OWNED_FIELDS } from '../../packages/core-commands/src/commands/prepare.ts';
import { AGENT_SURFACE } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { TOP_LEVEL_FIELDS } from './d06-cases.ts';
import {
  COMMAND_SURFACE,
  effectOperationId,
  type CommandName,
} from '../../packages/core-wire/src/surface.ts';
import {
  Tally,
  durableProbe,
  roomToApprove,
  expectUnchanged,
  lastAudit,
  probeValue,
  type Durable,
} from './d06-cases.ts';
import { onStep } from './d06-agent-onboarding.ts';
import { createHarness, type Harness } from './role-case-harness.ts';
import { agentHold } from './d06-agent-fixture.ts';
import { revisedState } from './d06-run-state.ts';
import type { Answer } from './world.ts';
import { serverUrl } from './world.ts';

if (serverUrl === undefined) {
  console.warn('acceptance/d06-agent: DATABASE_URL is unset, so nothing below ran.');
}

/** The agent's operations with a positive control, in the order the journey needs them. */
const AGENT_OPERATIONS: readonly CommandName[] = [
  'task.queue',
  'session.capabilities',
  'task.read',
  'task.comment',
  'task.propose',
  'run.revise_state',
  'task.heartbeat',
  'task.dispatch',
  'task.observe',
  'task.check',
  'model.call',
  'task.pickup',
  'task.handback',
  'onboarding.step_result',
];

/** A business-internal field the replay operation may take to its cloud route. */
/** Bound to the run's own task, which a person entered: only the broker finds a source business-internal (S3). */
const toneOn = (taskId: string) =>
  ({ name: 'tone', from: { recordId: taskId, key: 'title' } }) as const;

/** In `AGENT_SURFACE` and still not the agent's: a person decides (case (j) of the matrix). */
const AGENT_EXCLUDED_BY_DESIGN: ReadonlySet<CommandName> = new Set(['task.decide']);

const cells = AGENT_OPERATIONS.flatMap((operation) =>
  TOP_LEVEL_FIELDS.map((key) => ({ operation, key })),
);
const excluded = COMMAND_SURFACE.map((one) => one.name)
  .filter((name) => !AGENT_OPERATIONS.includes(name))
  .flatMap((operation) => SYSTEM_OWNED_FIELDS.map((key) => ({ operation, key })));

// eslint-disable-next-line max-lines-per-function -- one fixture, and the cells that share it
describe.skipIf(serverUrl === undefined)('D06 on the agent prefix', () => {
  let harness: Harness;
  let durable: () => Promise<Durable>;
  const hold = agentHold(() => harness);
  const tally = new Tally();

  beforeAll(async () => {
    harness = await createHarness('d06a');
    await roomToApprove(harness);
    durable = await durableProbe(harness);
  }, 120_000);

  afterAll(async () => {
    tally.print('agent prefix');
    await harness?.close();
  });

  /** A valid body for one agent operation, and the credential it travels with. */
  async function positive(
    name: CommandName,
  ): Promise<{ body: Record<string, unknown>; credential?: string }> {
    const operationId = randomUUID();
    if (name === 'task.queue') return { body: { operationId } };
    if (name === 'task.pickup') {
      await hold.release();
      return { body: { operationId, reservationId: await hold.reservation() } };
    }
    if (name === 'task.handback') await hold.release();
    // A call holds 500 and spends 100 of the reservation's 3,000, so each gets
    // a lease of its own rather than draining one.
    if (name === 'model.call') await hold.release();
    if (name === 'onboarding.step_result')
      return onStep(harness, operationId, hold.release, hold.track);
    const held = await hold.ensureLive();
    const credential = held.credential;
    if (name === 'session.capabilities') return { body: { operationId }, credential };
    if (name === 'task.read') return { body: { operationId, recordId: held.taskId }, credential };
    if (name === 'task.comment') {
      const body = { recordId: held.taskId, body: 'the agent notes it', audience: 'internal' };
      return { body: { operationId, ...body }, credential };
    }
    if (name === 'task.propose') {
      // The picked-up task's envelope holds its approved work to the minor
      // unit; room is widened here as `roomToApprove` widens the cap, so the
      // positive control is a proposal and the cell tests the field.
      await harness.world.db.admin.execute(
        `update public.task_envelopes set maximum_minor = maximum_minor + 1000000
          where business_id = $1 and state = 'open'`,
        [harness.world.alpha],
      );
      const read = await harness.asAgent(
        'task.read',
        { operationId: randomUUID(), recordId: held.taskId },
        credential,
      );
      const task = (read.body['detail'] as { task: { revision: number } }).task;
      const body = {
        recordId: held.taskId,
        expectedRevision: task.revision,
        purpose: 'synthetic_comment',
        maximumMinor: 100,
        currency: 'AUD',
        payload: { change: 'a synthetic change' },
        step: { kind: 'synthetic_comment', payload: {} },
      };
      return { body: { operationId, ...body }, credential };
    }
    const state = name === 'run.revise_state' ? await revisedState(harness.world, held) : null;
    if (state !== null) return { body: { operationId, ...state }, credential };
    if (name === 'task.heartbeat' || name === 'task.dispatch') {
      return { body: { operationId, leaseId: held.leaseId, fence: held.fence }, credential };
    }
    if (name === 'task.observe') {
      // The step dispatched and its one effect applied first; both replay (T2c2).
      const lease = { leaseId: held.leaseId, fence: held.fence };
      await harness.asAgent('task.dispatch', lease, credential);
      await harness.asAgent(
        'task.comment',
        {
          operationId: effectOperationId(held.attemptId),
          recordId: held.taskId,
          body: 'the synthetic effect',
          audience: 'internal',
        },
        credential,
      );
      return { body: { operationId, ...lease, attemptId: held.attemptId }, credential };
    }
    const own =
      name === 'task.check'
        ? { name: 'the agent checks', outcome: 'passed' }
        : name === 'model.call'
          ? { operation: 'model.replay_compose', fields: [toneOn(held.taskId)] }
          : { outcome: 'completed', report: { wrote: 'a draft' } };
    const body = { operationId, leaseId: held.leaseId, fence: held.fence, ...own };
    return { body, credential };
  }

  async function send(
    name: CommandName,
    prepared: { body: Record<string, unknown>; credential?: string },
  ): Promise<Answer> {
    const answer = await harness.asAgent(name, prepared.body, prepared.credential);
    if (name === 'task.pickup') hold.track(answer);
    if (name === 'task.handback' && answer.code === 'ok') hold.settled();
    return answer;
  }

  it.each(cells)(
    'agent $operation refuses top-level $key, and writes nothing',
    async (cell) => {
      const value = probeValue(cell.key);
      const control = await send(cell.operation, await positive(cell.operation));
      expect(control.code, `positive control for ${cell.operation}`).toBe('ok');

      const prepared = await positive(cell.operation);
      const before = await durable();
      const injected = { ...prepared, body: { ...prepared.body, [cell.key]: value } };
      const answer = await send(cell.operation, injected);
      const after = await durable();
      // Counted here, before the contract line, so a red cell is still a cell that ran.
      tally.count(cell.operation, 'agent', answer.code === 'FIELD_NOT_WRITABLE');
      // The contract outcome. At the reviewed milestone this is the first line
      // to fail: the envelope serves the request and the answer is `ok`.
      expect(answer.code).toBe('FIELD_NOT_WRITABLE');
      expect(answer.body['names']).toStrictEqual([cell.key]);
      if (typeof value === 'string') expect(JSON.stringify(answer.body)).not.toContain(value);
      const audit = await lastAudit(harness);
      expectUnchanged(before, after, audit, {
        operation: cell.operation,
        code: 'FIELD_NOT_WRITABLE',
        door: after.doorLog - before.doorLog,
      });
      expect(after.doorLog - before.doorLog).toBeGreaterThan(0);
      expect(audit['attempted']).toStrictEqual({ [cell.key]: value });

      const clean = await send(cell.operation, {
        ...prepared,
        body: { ...prepared.body, operationId: randomUUID() },
      });
      expect(clean.code, 'the injected request, without the field').toBe('ok');
    },
    60_000,
  );

  it.each(excluded)(
    'agent $operation, not the agent’s, refuses top-level $key and writes nothing',
    async (cell) => {
      const value = probeValue(cell.key);
      const held = await hold.ensureLive();
      const declaration = COMMAND_SURFACE.find((one) => one.name === cell.operation);
      if (declaration === undefined) throw new Error(`d06-agent: ${cell.operation} undeclared`);
      const body = { ...harness.probeBody(declaration), [cell.key]: value };
      const before = await durable();
      const answer = await harness.asAgent(cell.operation, body, held.credential);
      const after = await durable();
      const reason = AGENT_EXCLUDED_BY_DESIGN.has(cell.operation)
        ? `a person decides; answered ${String(answer.body['code'])}`
        : `not in AGENT_SURFACE; answered ${String(answer.body['code'])}`;
      tally.count(cell.operation, 'agent', answer.body['refused'] === true, reason);
      expect(answer.body['refused']).toBe(true);
      if (typeof value === 'string') expect(JSON.stringify(answer.body)).not.toContain(value);
      const audit = await lastAudit(harness);
      expectUnchanged(before, after, audit, {
        operation: cell.operation,
        code: String(answer.body['code']),
        door: after.doorLog - before.doorLog,
      });
      // The request was authenticated, so the door log saw it.
      expect(after.doorLog - before.doorLog).toBeGreaterThan(0);
      expect(AGENT_SURFACE.has(cell.operation)).toBe(AGENT_EXCLUDED_BY_DESIGN.has(cell.operation));
    },
    60_000,
  );
});
