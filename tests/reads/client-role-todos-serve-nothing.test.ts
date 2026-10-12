// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.todos` serves the internal task summary: start date, category,
// assignee, tags and waiting counts. A member whose role is not an internal
// one (a client) reads a task only through the shared-field allowlist, so the
// to-do read is not theirs, even with business-wide `task:read` and a task
// assigned to them: it answers the one NOT_FOUND an unadmitted read gets, and
// names nothing. An internal member is still served the same task.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { timeWorld, type TimeWorld } from '../commands/time-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('client-role todos: DATABASE_URL is unset, so nothing below ran.');
}

let w: TimeWorld;
let client: Member;
let taskId = '';

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('crt');
  taskId = await w.fresh(w.alpha, w.ada, 'assigned to a client-role member');
  client = await enrol(w.db.app, w.alpha, 'client-cora');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await tx.query(`update memberships set role_key = 'client' where person_id = $1`, [
      client.personId,
    ]);
    await grantTo(tx, client, 'read');
  });
  // Assigned to the client-role member, with a start date: the fields a to-do row carries.
  await w.db.admin.execute(
    `update public.records
        set data = data || jsonb_build_object('assignee', $2::text, 'started_at', '2026-01-02T03:04:05Z')
      where id = $1`,
    [taskId, client.personId],
  );
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

describe.skipIf(serverUrl === undefined)('task.todos and a member who is not internal', () => {
  it('a client-role member with business task:read is refused and shown no internal field', async () => {
    for (const scope of [{}, { person: client.personId }]) {
      // eslint-disable-next-line no-await-in-loop -- one scope at a time
      const answer = await executeRead(w.db.app, w.alpha, client.presented, {
        read: 'task.todos',
        ...scope,
      });
      const body = JSON.stringify(answer);
      expect(isCommandRefusal(answer) ? answer.code : 'served', body.slice(0, 300)).toBe(
        'NOT_FOUND',
      );
      expect(body).not.toContain(taskId);
      expect(body).not.toMatch(/startedAt|2026-01-02/u);
    }
  });

  it('the same member in an internal role is served the task', async () => {
    const roleIs = async (role: string) =>
      await w.db.app.withBusiness(w.alpha, async (tx) => {
        await tx.query(`update memberships set role_key = $2 where person_id = $1`, [
          client.personId,
          role,
        ]);
      });
    await roleIs('member');
    try {
      const answer = await executeRead(w.db.app, w.alpha, client.presented, { read: 'task.todos' });
      expect(isCommandRefusal(answer) ? answer.code : 'served').toBe('served');
      expect(JSON.stringify(answer)).toContain(taskId);
    } finally {
      await roleIs('client');
    }
  });
});
