// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-6 on both prefixes, through the real application: one envelope parsing
// each request once. Each `describe` is named for the ticket's line it
// proves. The source-level lines (no casts, one envelope's single home) are
// `tests/commands/cq-6.test.ts`.
//
// Boundaries named and proved here (standing gate 9): business to business
// (alpha's callers against bravo's task), person to person (rhea, holding
// grants on one alpha task, against another), agent to agent (one agent's
// credential against the other agent's pickup), and a caller against a
// business it is not a member of.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { statusOf } from '../../packages/core-records/src/index.ts';
import type { RefusalCode } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  auditMark,
  auditSince,
  createIdentWorld,
  type IdentWorld,
  type Picked,
  type RawAnswer,
} from '../acceptance/ident-audit-cases.ts';

const CANARY = `cq6-canary-${randomUUID()}`;

/** The answer's code, with the status the register gives that code. */
function expectRefused(answer: RawAnswer, code: RefusalCode, label: string): void {
  expect(answer.code, `${label}: ${answer.text}`).toBe(code);
  expect(answer.status, label).toBe(statusOf(code));
}

// eslint-disable-next-line max-lines-per-function -- one world, every CQ-6 line on it
describe.skipIf(serverUrl === undefined)('CQ-6 on both prefixes', () => {
  let w: IdentWorld;
  let own: Picked;

  beforeAll(async () => {
    w = await createIdentWorld('cq_6');
    own = await w.pickUp(w.h.world.agent, 'the agent’s own task for CQ-6');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const revisionOf = async (taskId: string): Promise<string | undefined> => {
    const rows = await w.h.world.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where id = $1`,
      [taskId],
    );
    return rows[0]?.revision;
  };
  const person = async (name: Parameters<IdentWorld['person']>[1], body: object) =>
    await w.person(w.h.world.ada, name, { ...body });
  const agent = async (name: Parameters<IdentWorld['agent']>[1], body: object) =>
    await w.agent(w.h.world.agent, name, { ...body }, own.credential);

  describe('CQ-6 operands described', () => {
    it('person prefix: a body that does not match its row is refused by name and changes nothing', async () => {
      const task = await w.h.freshTask('a task ranked with a mistyped neighbour');
      const before = await revisionOf(task.id);
      const answer = await person('task.rank', {
        recordId: task.id,
        expectedRevision: task.revision,
        afterId: 5,
      });
      expectRefused(answer, 'FIELD_VALUE_INVALID', 'rank afterId 5');
      expect(answer.body['names']).toStrictEqual(['afterId']);
      expect(await revisionOf(task.id)).toBe(before);
    });

    it('agent prefix: a body that does not match its row is refused by name before the command runs', async () => {
      const handback = await agent('task.handback', {
        leaseId: own.leaseId,
        fence: 'not a fence',
        outcome: 'completed',
      });
      expectRefused(handback, 'FIELD_VALUE_INVALID', 'agent handback fence');
      expect(handback.body['names']).toStrictEqual(['fence']);
      const personTarget = await person('task.comment', {
        recordId: [own.taskId],
        expectedRevision: 1,
        body: 'b',
        audience: 'internal',
      });
      const agentTarget = await agent('task.comment', {
        recordId: [own.taskId],
        body: 'b',
        audience: 'internal',
      });
      expectRefused(agentTarget, 'NOT_FOUND', 'agent comment recordId array');
      expect(agentTarget.text).toBe(personTarget.text);
    });
  });

  describe('CQ-6 one envelope', () => {
    it('the agent’s OPERATION_ID_REQUIRED gives the person’s two fixes', async () => {
      const personAnswer = await person('task.create', {
        operationId: undefined,
        fields: { title: 'x' },
      });
      const agentAnswer = await agent('task.read', {
        operationId: undefined,
        recordId: own.taskId,
      });
      expectRefused(personAnswer, 'OPERATION_ID_REQUIRED', 'person');
      expectRefused(agentAnswer, 'OPERATION_ID_REQUIRED', 'agent');
      expect(personAnswer.body['fixes']).toHaveLength(2);
      expect(agentAnswer.body['fixes']).toStrictEqual(personAnswer.body['fixes']);
    });
  });

  describe('CQ-6 refusal parity', () => {
    it('person prefix: each refusal keeps its code, status and precedence', async () => {
      const task = await w.h.freshTask('a task for the person refusal table');
      const reused = randomUUID();
      await person('task.create', { operationId: reused, fields: { title: 'first' } });
      const cases: readonly (readonly [string, object, RefusalCode])[] = [
        [
          'no identity, before anything',
          { operationId: 7, fields: 'x', actorId: 'a' },
          'OPERATION_ID_REQUIRED',
        ],
        [
          'no revision, before a system field',
          { recordId: task.id, actorId: 'a', fields: {} },
          'EXPECTED_REVISION_REQUIRED',
        ],
        [
          'a system field, before the operands',
          { recordId: task.id, expectedRevision: task.revision, actorId: 'a', fields: 'x' },
          'FIELD_NOT_WRITABLE',
        ],
        [
          'a missing record, before the operands',
          { recordId: randomUUID(), expectedRevision: 1, fields: 'x' },
          'NOT_FOUND',
        ],
        [
          'a stale revision, before the operands',
          { recordId: task.id, expectedRevision: task.revision + 9, fields: 'x' },
          'VERSION_STALE',
        ],
      ];
      for (const [label, body, code] of cases) {
        // eslint-disable-next-line no-await-in-loop -- one call at a time
        expectRefused(await person('task.update', body), code, label);
      }
      const again = await person('task.create', {
        operationId: reused,
        fields: { title: 'other' },
      });
      expectRefused(again, 'OPERATION_ID_REUSED', 'reused identity');
    });

    it('agent prefix: each refusal keeps its code, status and precedence', async () => {
      const sibling = await w.h.freshTask('a sibling outside the delegation');
      const cases: readonly (readonly [
        string,
        Parameters<IdentWorld['agent']>[1],
        object,
        RefusalCode,
      ])[] = [
        [
          'outside its reach, before the identity',
          'task.assign',
          { operationId: undefined },
          'DELEGATION_EXCLUDES_OPERATION',
        ],
        [
          'no identity',
          'task.read',
          { operationId: 7, recordId: own.taskId },
          'OPERATION_ID_REQUIRED',
        ],
        [
          'a system field, before authority',
          'task.comment',
          { recordId: sibling.id, actorId: 'a', body: 'b', audience: 'internal' },
          'FIELD_NOT_WRITABLE',
        ],
        [
          'a sibling task',
          'task.comment',
          { recordId: sibling.id, body: 'b', audience: 'internal' },
          'DELEGATION_OUT_OF_PURPOSE',
        ],
      ];
      for (const [label, name, body, code] of cases) {
        // eslint-disable-next-line no-await-in-loop -- one call at a time
        expectRefused(await agent(name, body), code, label);
      }
    });
  });

  describe('CQ-6 delegation excludes', () => {
    it('an agent never reaches an operation outside its delegation, whatever the body', async () => {
      const task = await w.h.freshTask('a task only a person may change');
      const before = await revisionOf(task.id);
      for (const name of [
        'task.create',
        'task.update',
        'task.assign',
        'task.trash',
        'grant.revoke',
      ] as const) {
        for (const body of [
          { recordId: task.id, expectedRevision: task.revision, fields: { title: 'x' } },
          { fields: 5, recordId: [task.id] },
        ]) {
          // eslint-disable-next-line no-await-in-loop -- one call at a time
          expectRefused(await agent(name, body), 'DELEGATION_EXCLUDES_OPERATION', name);
        }
      }
      expect(await revisionOf(task.id)).toBe(before);
    });
  });

  describe('CQ-6 replay both prefixes', () => {
    it('person prefix: a retried create returns the stored answer and makes one task', async () => {
      const operationId = randomUUID();
      const first = await person('task.create', {
        operationId,
        fields: { title: 'replayed once' },
      });
      const second = await person('task.create', {
        operationId,
        fields: { title: 'replayed once' },
      });
      expect(first.status, first.text).toBe(200);
      // The register holds the answer as JSONB, so the replay's keys may come
      // back in another order; the answer itself is the same.
      expect(second.body).toStrictEqual(first.body);
      const task = await w.h.freshTask('a task a refused rank is retried on');
      const refused = {
        operationId: `${operationId}-r`,
        recordId: task.id,
        expectedRevision: task.revision,
        afterId: 5,
      };
      const refusedFirst = await person('task.rank', refused);
      const refusedAgain = await person('task.rank', refused);
      expect(refusedFirst.code).toBe('FIELD_VALUE_INVALID');
      expect(refusedAgain.text).toBe(refusedFirst.text);
    });

    it('agent prefix: a retried comment returns the stored answer', async () => {
      const operationId = randomUUID();
      const body = { operationId, recordId: own.taskId, body: 'once', audience: 'internal' };
      const first = await agent('task.comment', body);
      const second = await agent('task.comment', body);
      expect(first.status, first.text).toBe(200);
      expect(second.body).toStrictEqual(first.body);
      const refused = {
        operationId: `${operationId}-r`,
        gateId: 5,
        versionId: randomUUID(),
        decision: 'approve',
        note: 'n',
      };
      const refusedFirst = await agent('task.decide', refused);
      const refusedAgain = await agent('task.decide', refused);
      expect(refusedFirst.code).toBe('DELEGATION_EXCLUDES_DECISION');
      expect(refusedAgain.text).toBe(refusedFirst.text);
    });
  });

  describe('CQ-6 isolation', () => {
    it('business to business: bravo’s task answers as a fabricated one on both prefixes, and does not move', async () => {
      const foreign = w.foreign.task;
      const before = await revisionOf(foreign.id);
      const body = (recordId: string) => ({
        recordId,
        expectedRevision: foreign.revision,
        fields: 'x',
      });
      const personForeign = await person('task.update', body(foreign.id));
      const personFabricated = await person('task.update', body(randomUUID()));
      expectRefused(personForeign, 'NOT_FOUND', 'person, bravo task');
      expect(personForeign.text).toBe(personFabricated.text);
      const agentForeign = await agent('task.comment', {
        recordId: foreign.id,
        body: 5,
        audience: 'internal',
      });
      const agentFabricated = await agent('task.comment', {
        recordId: randomUUID(),
        body: 5,
        audience: 'internal',
      });
      expect(agentForeign.text).toBe(agentFabricated.text);
      expect(await revisionOf(foreign.id)).toBe(before);
    });

    it('a member of alpha is refused bravo’s business by key, on both prefixes', async () => {
      const personAnswer = await w.person(
        w.h.world.ada,
        'task.update',
        { recordId: w.foreign.task.id, expectedRevision: 1, fields: 'x' },
        'bravo',
      );
      expectRefused(personAnswer, 'AUTH_NO_MEMBERSHIP', 'person on bravo');
      const agentAnswer = await w.agent(
        w.h.world.agent,
        'task.read',
        { recordId: w.foreign.task.id },
        own.credential,
        'bravo',
      );
      expect(agentAnswer.status, agentAnswer.text).toBeGreaterThanOrEqual(400);
      expect(agentAnswer.text).not.toContain(w.foreign.task.id);
    });

    it('person to person: a mistyped body does not get past another person’s record', async () => {
      const unreached = await w.h.freshTask('an alpha task outside rhea’s grant');
      const before = await revisionOf(unreached.id);
      const answer = await w.person(w.rhea, 'task.update', {
        recordId: unreached.id,
        expectedRevision: unreached.revision,
        fields: 'x',
      });
      expect(answer.code).not.toBe('FIELD_VALUE_INVALID');
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(await revisionOf(unreached.id)).toBe(before);
    });

    it('agent to agent: one agent’s credential does not reach the other agent’s task', async () => {
      const before = await revisionOf(w.otherPicked.taskId);
      const answer = await agent('task.comment', {
        recordId: w.otherPicked.taskId,
        body: 5,
        audience: 'internal',
      });
      expectRefused(answer, 'DELEGATION_OUT_OF_PURPOSE', 'other agent’s task');
      expect(await revisionOf(w.otherPicked.taskId)).toBe(before);
    });
  });

  describe('CQ-6 operands described: undescribed fields', () => {
    it('a field its row does not describe is refused on both prefixes, and its key is not echoed', async () => {
      const task = await w.h.freshTask('a task an undescribed field is sent to');
      const before = await revisionOf(task.id);
      const key = `unlisted_${CANARY}`;
      const personAnswer = await person('task.complete', {
        recordId: task.id,
        expectedRevision: task.revision,
        [key]: 'a caller-supplied value',
      });
      expectRefused(personAnswer, 'COMMAND_BODY_INVALID', 'person, undescribed field');
      expect(personAnswer.text).not.toContain(CANARY);
      expect(await revisionOf(task.id)).toBe(before);
      const agentAnswer = await agent('task.comment', {
        recordId: own.taskId,
        body: 'a comment the row refuses',
        audience: 'internal',
        [key]: 'a caller-supplied value',
      });
      expectRefused(agentAnswer, 'COMMAND_BODY_INVALID', 'agent, undescribed field');
      expect(agentAnswer.text).not.toContain(CANARY);
      expect(personAnswer.body['names']).toStrictEqual([]);
      expect(agentAnswer.body['names']).toStrictEqual([]);
    });
  });

  describe('CQ-6 canary', () => {
    it('a canary secret and record content in a refused body reach no log, audit row or refusal', async () => {
      const logged: string[] = [];
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(
            args
              .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
              .join(' '),
          );
        }),
      );
      try {
        const task = await w.h.freshTask('a task a canary body is refused on');
        const mark = await auditMark(w.h);
        const answers = [
          await person('task.rank', {
            recordId: task.id,
            expectedRevision: task.revision,
            afterId: { secret: CANARY },
            note: CANARY,
          }),
          await person('task.update', {
            recordId: task.id,
            expectedRevision: task.revision,
            fields: CANARY,
          }),
          await agent('task.decide', {
            gateId: [CANARY],
            versionId: randomUUID(),
            decision: 'approve',
            note: CANARY,
          }),
          await agent('task.update', { recordId: task.id, fields: { title: CANARY } }),
        ];
        for (const answer of answers) {
          expect(answer.status, answer.text).toBeGreaterThanOrEqual(400);
          expect(answer.text).not.toContain(CANARY);
        }
        const rows = await auditSince(w.h, mark);
        expect(rows.length).toBeGreaterThanOrEqual(answers.length);
        expect(JSON.stringify(rows)).not.toContain(CANARY);
        expect(logged.join('\n')).not.toContain(CANARY);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    });
  });
});
