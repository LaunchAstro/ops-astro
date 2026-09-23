// SPDX-License-Identifier: AGPL-3.0-only
//
// D06 on the agent path: a system-owned field in an agent's request is refused,
// audited, and changes nothing.
//
// CONTRACT-LEDGER line 78: every operation payload attempts system-field
// injection and observes "typed refusal and unchanged DB"; ignoring the hostile
// field silently is the named negative. The classifier is the person path's
// own (`prepare.ts`), so the set of fields below is read from it, not copied.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { SYSTEM_OWNED_FIELDS } from '../../packages/core-records/src/commands/prepare.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { agentWorld, codeOf, type AgentWorld, type PickedUp } from './agent-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('system-owned fields on the agent path', () => {
  let world: AgentWorld;
  let picked: PickedUp;

  beforeAll(async () => {
    world = await agentWorld('s', 'agent-system-fields');
    picked = await world.pickUp(await world.decider('commenter'), 'a task an agent comments on');
  }, 90_000);

  afterAll(async () => {
    await world?.drop();
  });

  const comment = (): Record<string, unknown> => ({
    command: 'task.comment',
    operationId: randomUUID(),
    recordId: picked.taskId,
    body: 'a note for the team',
    audience: 'internal',
  });

  it('writes a valid agent comment', async () => {
    const before = await world.commentsOn(picked.taskId);
    const written = await world.asAgent(comment(), picked.credential);
    expect(isCommandRefusal(written)).toBe(false);
    expect(await world.commentsOn(picked.taskId)).toBe(before + 1);
  });

  it.each(SYSTEM_OWNED_FIELDS)(
    'refuses a comment carrying %s, audited, with no comment written',
    async (field) => {
      const before = await world.commentsOn(picked.taskId);
      const request = { ...comment(), [field]: 'forged' };
      const refused = await world.asAgent(request, picked.credential);
      expect(codeOf(refused)).toBe('FIELD_NOT_WRITABLE');
      expect(isCommandRefusal(refused) ? refused.names : []).toStrictEqual([field]);
      expect(JSON.stringify(refused)).not.toContain('forged');
      expect(await world.commentsOn(picked.taskId)).toBe(before);
      expect(await world.auditFor(String(request['operationId']))).toStrictEqual([
        { outcome: 'refused', code: 'FIELD_NOT_WRITABLE' },
      ]);
    },
  );

  it('refuses a system-owned field on every agent operation, before any delegation', async () => {
    for (const command of [
      'task.queue',
      'task.pickup',
      'task.read',
      'task.heartbeat',
      'task.handback',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const refused = await world.asAgent({
        command,
        operationId: randomUUID(),
        actor_id: randomUUID(),
      });
      expect(codeOf(refused), command).toBe('FIELD_NOT_WRITABLE');
    }
  });
});
