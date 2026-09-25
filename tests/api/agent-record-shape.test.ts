// SPDX-License-Identifier: AGPL-3.0-only
//
// The task an agent is authorised on is the task it is served (THERMO-RECHECK-2
// NNA1). At e84add2 the delegation check took `recordId` only when it was a
// string and otherwise checked the agent's own task, while `task.comment` and
// `task.read` then served `String(recordId)`: `recordId: ["<sibling>"]` was
// authorised on the agent's own task and wrote a comment on, or read, a sibling
// task in the same business. A `recordId` that is present and not a string now
// names nothing, before any authority is read, in the bytes the person prefix
// answers the same body with; and nothing in either business moves.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  auditMark,
  auditSince,
  createIdentWorld,
  domainState,
  expectAudited,
  type IdentWorld,
  type Picked,
} from '../acceptance/ident-audit-cases.ts';

type Body = Readonly<Record<string, unknown>>;

const SECRET = 'a sibling title the agent must not be shown';
const NOTE = 'a note that must land on no sibling';

describe.skipIf(serverUrl === undefined)('agent recordId shape (NNA1)', () => {
  let w: IdentWorld;
  let alpha: string;
  let bravo: string;
  let own: Picked;
  let sibling: string;

  beforeAll(async () => {
    w = await createIdentWorld('agent_record_shape');
    alpha = w.h.world.alpha;
    bravo = w.h.world.bravo;
    own = await w.pickUp(w.h.world.agent, 'the agent’s own task');
    sibling = (await w.h.freshTask(SECRET)).id;
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const commentsOn = async (taskId: string): Promise<number> => {
    const rows = await w.h.world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.records
        where business_id = $1 and data->>'task' = $2`,
      [alpha, taskId],
    );
    return Number(rows[0]?.n ?? 0);
  };

  /** Every JSON shape of `recordId` that is not a string, each naming the sibling where it can. */
  const SHAPES = (): Readonly<Record<string, unknown>> => ({
    array: [sibling],
    'nested array': [[sibling]],
    object: { id: sibling },
    number: 42,
    boolean: true,
    null: null,
  });

  const BODIES: Readonly<Record<'task.comment' | 'task.read', (recordId: unknown) => Body>> = {
    'task.comment': (recordId) => ({ recordId, body: NOTE, audience: 'internal' }),
    'task.read': (recordId) => ({ recordId }),
  };

  /**
   * Each operation's refusal for a non-string id on the person prefix: the
   * command path answers a missing record, the read its own operand rule.
   */
  const REFUSED: Readonly<Record<'task.comment' | 'task.read', string>> = {
    'task.comment': 'NOT_FOUND',
    'task.read': 'FIELD_VALUE_INVALID',
  };

  /** The person body: a person's comment also names the revision it writes against. */
  const personBody = (op: 'task.comment' | 'task.read', recordId: unknown): Body =>
    op === 'task.comment' ? { ...BODIES[op](recordId), expectedRevision: 1 } : BODIES[op](recordId);

  it('controls: the agent reads and comments on its own task, and a string sibling is out of purpose', async () => {
    const read = await w.agent(
      w.h.world.agent,
      'task.read',
      { recordId: own.taskId },
      own.credential,
    );
    expect(read.status, read.text).toBe(200);
    const comment = await w.agent(
      w.h.world.agent,
      'task.comment',
      BODIES['task.comment'](own.taskId),
      own.credential,
    );
    expect(comment.status, comment.text).toBe(200);
    for (const op of ['task.read', 'task.comment'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one call at a time
      const outside = await w.agent(w.h.world.agent, op, BODIES[op](sibling), own.credential);
      expect(outside.code, `${op} ${outside.text}`).toBe('DELEGATION_OUT_OF_PURPOSE');
    }
  });

  it('refuses a recordId that is not a string, before authority, as the person prefix does', async () => {
    const before = await commentsOn(sibling);
    for (const op of ['task.comment', 'task.read'] as const satisfies readonly CommandName[]) {
      for (const [shape, recordId] of Object.entries(SHAPES())) {
        /* eslint-disable no-await-in-loop -- each shape against its own before and after */
        const label = `${op} recordId ${shape}`;
        const body = { operationId: randomUUID(), ...BODIES[op](recordId) };
        const state = await domainState(w.h, [alpha, bravo]);
        const mark = await auditMark(w.h);
        const agent = await w.agent(w.h.world.agent, op, body, own.credential);
        const rows = await auditSince(w.h, mark);
        expect.soft(agent.status, `${label}: ${agent.text}`).not.toBe(200);
        expect.soft(agent.text, label).not.toContain(SECRET);
        expect.soft(agent.code, `${label}: ${agent.text}`).toBe(REFUSED[op]);
        expect
          .soft(await domainState(w.h, [alpha, bravo]), `${label}: durable state`)
          .toStrictEqual(state);
        // The person prefix, the same body: one answer for one mistake.
        const person = await w.person(w.h.world.ada, op, personBody(op, recordId));
        expect.soft(agent.status, `${label}: against the person prefix`).toBe(person.status);
        expect.soft(agent.text, `${label}: against the person prefix`).toBe(person.text);
        expectAudited(label, rows, {
          businessId: alpha,
          actorId: w.h.world.agent.actorId,
          command: op,
          operationId: body.operationId,
          outcome: 'refused',
          refusalCode: REFUSED[op],
          body,
        });
        /* eslint-enable no-await-in-loop */
      }
    }
    expect(await commentsOn(sibling)).toBe(before);
  }, 300_000);

  it('refuses the shape before the delegation is read', async () => {
    // No credential at all: the body is refused first, so a caller learns
    // nothing about the delegation from a malformed id.
    for (const op of ['task.comment', 'task.read'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one call at a time
      const bare = await w.agent(w.h.world.agent, op, BODIES[op]([sibling]));
      expect(bare.code, `${op} ${bare.text}`).toBe(REFUSED[op]);
    }
  });
});
