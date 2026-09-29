// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-6, a body field its surface row does not describe (Sol's review 1 on
// #91, criterion 6), on both prefixes through the real application. Kept
// apart from `tests/api/cq-6.test.ts` so neither file passes the per-file
// size cap. Boundaries: none crossed; the refusal names no caller key.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { statusOf } from '../../packages/core-records/src/index.ts';
import type { RefusalCode } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  createIdentWorld,
  type IdentWorld,
  type Picked,
  type RawAnswer,
} from '../acceptance/ident-audit-cases.ts';

const CANARY = `cq6-canary-${randomUUID()}`;

function expectRefused(answer: RawAnswer, code: RefusalCode, label: string): void {
  expect(answer.code, `${label}: ${answer.text}`).toBe(code);
  expect(answer.status, label).toBe(statusOf(code));
}

describe.skipIf(serverUrl === undefined)('CQ-6 undescribed fields on both prefixes', () => {
  let w: IdentWorld;
  let own: Picked;

  beforeAll(async () => {
    w = await createIdentWorld('cq_6_body');
    own = await w.pickUp(w.h.world.agent, 'the agent’s own task for the CQ-6 body check');
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
  describe('CQ-6 operands described: undescribed identifiers', () => {
    it('an identifier its row does not declare is refused on both prefixes', async () => {
      const task = await w.h.freshTask('a task sent identifiers it does not take');
      const before = await revisionOf(task.id);
      for (const field of ['gateId', 'batchId', 'parentId', 'leaseId', 'lineageId']) {
        // eslint-disable-next-line no-await-in-loop -- one call at a time
        const answer = await person('task.complete', {
          recordId: task.id,
          expectedRevision: task.revision,
          [field]: randomUUID(),
        });
        expectRefused(answer, 'COMMAND_BODY_INVALID', `person task.complete ${field}`);
      }
      expect(await revisionOf(task.id)).toBe(before);
      for (const field of ['gateId', 'versionId', 'reservationId']) {
        // eslint-disable-next-line no-await-in-loop -- one call at a time
        const answer = await agent('task.comment', {
          recordId: own.taskId,
          body: 'a comment with an identifier it does not take',
          audience: 'internal',
          [field]: randomUUID(),
        });
        expectRefused(answer, 'COMMAND_BODY_INVALID', `agent task.comment ${field}`);
      }
    });
  });
});
