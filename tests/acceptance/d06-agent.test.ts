// SPDX-License-Identifier: AGPL-3.0-only
//
// D06 on the agent prefix, generated the same way as `d06-generated.test.ts`.
//
// The agent's own operations are `AGENT_SURFACE`, and each has a real positive
// control here: the queue before any pickup, a pickup of a freshly approved
// reservation, and a read, a comment, a heartbeat, the capabilities read and a
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
import { SYSTEM_OWNED_FIELDS } from '../../packages/core-records/src/commands/prepare.ts';
import { AGENT_SURFACE } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { TOP_LEVEL_FIELDS } from './d06-cases.ts';
import {
  COMMAND_SURFACE,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import {
  Tally,
  durableProbe,
  roomToApprove,
  expectUnchanged,
  lastAudit,
  probeValue,
  type Durable,
} from './d06-cases.ts';
import { createHarness, type Harness } from './role-case-harness.ts';
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
  'task.heartbeat',
  'task.pickup',
  'task.handback',
];

/** In `AGENT_SURFACE` and still not the agent's: a person decides (case (j) of the matrix). */
const AGENT_EXCLUDED_BY_DESIGN: ReadonlySet<CommandName> = new Set(['task.decide']);

const cells = AGENT_OPERATIONS.flatMap((operation) =>
  TOP_LEVEL_FIELDS.map((key) => ({ operation, key })),
);
const excluded = COMMAND_SURFACE.map((one) => one.name)
  .filter((name) => !AGENT_OPERATIONS.includes(name))
  .flatMap((operation) => SYSTEM_OWNED_FIELDS.map((key) => ({ operation, key })));

interface Pickup {
  readonly credential: string;
  readonly delegationId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly taskId: string;
}

// eslint-disable-next-line max-lines-per-function -- one fixture, and the cells that share it
describe.skipIf(serverUrl === undefined)('D06 on the agent prefix', () => {
  let harness: Harness;
  let durable: () => Promise<Durable>;
  /** The one delegation the agent holds, if any: an agent may hold one at a time. */
  let live: Pickup | undefined;
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

  /** A reservation a person approved, ready to be picked up. */
  async function reservation(): Promise<string> {
    const { decided } = await harness.approvedReservation();
    expect(decided.code, 'the decision a pickup needs').toBe('ok');
    return String((decided.body['detail'] as Record<string, unknown>)['reservationId']);
  }

  /** Remember a pickup the server granted, whether or not the cell wanted it. */
  function track(answer: Answer): void {
    if (answer.code !== 'ok') return;
    const detail = answer.body['detail'] as Record<string, unknown>;
    live = {
      credential: String(detail['credential']),
      delegationId: String(detail['delegationId']),
      leaseId: String(detail['leaseId']),
      fence: Number(detail['fence']),
      taskId: String(detail['taskId']),
    };
  }

  /** Give the held delegation back through its owning operation, as the person who granted it. */
  async function release(): Promise<void> {
    if (live === undefined) return;
    await harness.asPerson('delegation.revoke', { delegationId: live.delegationId });
    live = undefined;
  }

  async function ensureLive(): Promise<Pickup> {
    if (live === undefined)
      track(await harness.asAgent('task.pickup', { reservationId: await reservation() }));
    if (live === undefined) throw new Error('d06-agent: the journey could not pick up');
    return live;
  }

  /** A valid body for one agent operation, and the credential it travels with. */
  async function positive(
    name: CommandName,
  ): Promise<{ body: Record<string, unknown>; credential?: string }> {
    const operationId = randomUUID();
    if (name === 'task.queue') return { body: { operationId } };
    if (name === 'task.pickup') {
      await release();
      return { body: { operationId, reservationId: await reservation() } };
    }
    if (name === 'task.handback') await release();
    const held = await ensureLive();
    const credential = held.credential;
    if (name === 'session.capabilities') return { body: { operationId }, credential };
    if (name === 'task.read') return { body: { operationId, recordId: held.taskId }, credential };
    if (name === 'task.comment') {
      const body = { recordId: held.taskId, body: 'the agent notes it', audience: 'internal' };
      return { body: { operationId, ...body }, credential };
    }
    if (name === 'task.heartbeat') {
      return { body: { operationId, leaseId: held.leaseId, fence: held.fence }, credential };
    }
    const outcome = { outcome: 'completed', report: { wrote: 'a draft' } };
    const body = { operationId, leaseId: held.leaseId, fence: held.fence, ...outcome };
    return { body, credential };
  }

  async function send(
    name: CommandName,
    prepared: { body: Record<string, unknown>; credential?: string },
  ): Promise<Answer> {
    const answer = await harness.asAgent(name, prepared.body, prepared.credential);
    if (name === 'task.pickup') track(answer);
    if (name === 'task.handback' && answer.code === 'ok') live = undefined;
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
      const held = await ensureLive();
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
