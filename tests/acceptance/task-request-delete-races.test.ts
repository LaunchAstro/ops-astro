// SPDX-License-Identifier: AGPL-3.0-only
//
// #2351's business boundary and races: another business never sees, confirms,
// keeps or asks about alpha's request, and two answers at once, each on a
// connection of its own, answer once. The cases: `task-request-delete.test.ts`.

import { describe, expect, it } from 'vitest';
import { serverUrl, type Answer } from './world.ts';
import { CANARY, okay, openRequestWorld } from './task-request-delete-world.ts';

const w = openRequestWorld('task_request_delete_races_2351');
const h = w.harness;

// eslint-disable-next-line max-lines-per-function -- one world, and the cases that share it
describe.skipIf(serverUrl === undefined)('a delete request across businesses and at once', () => {
  it("another business never sees, confirms, keeps or asks about alpha's task", async () => {
    const task = await h().freshTask('a task bravo tries');
    okay(await w.ask(task.id));
    const body = { recordId: task.id, expectedRevision: await w.revisionOf(task.id) };
    const answers: Answer[] = [];
    for (const name of ['task.confirm_delete', 'task.decline_delete', 'task.read'] as const) {
      // Bea, through bravo's prefix with alpha's id, and through alpha's, where she is no member.
      for (const key of ['bravo', 'alpha']) {
        // eslint-disable-next-line no-await-in-loop
        answers.push(await h().asPerson(name, body, key, h().world.bea));
      }
    }
    // Bravo's agent credential, by alpha's id through bravo's prefix and through alpha's.
    const asked = { ...body, reason: 'from bravo' };
    for (const key of ['bravo', 'alpha']) {
      // eslint-disable-next-line no-await-in-loop
      answers.push(await w.asCredential('task.request_delete', asked, w.bravoSecret(), key));
    }
    for (const one of answers) {
      expect(one.status, one.text).not.toBe(200);
      expect(one.code).not.toBe('ok');
      expect(one.text, 'no reason, title or id across the boundary').not.toContain(CANARY);
      expect(one.text).not.toContain('a task bravo tries');
    }
    expect(answers[0]?.code).toBe('NOT_FOUND');
    expect(await w.readCode(task.id)).toBe('ok');
    const pending = await w.pendingOn(task.id);
    expect(pending?.['reason'], 'the request is unchanged').toBe(`${CANARY} a test task`);
  });

  it('two confirms at once delete once', async () => {
    const task = await h().freshTask('a task confirmed twice at once');
    okay(await w.ask(task.id));
    const expectedRevision = await w.revisionOf(task.id);
    const both = await Promise.all(
      [1, 2].map(
        async () =>
          await w.asAdaWide('task.confirm_delete', { recordId: task.id, expectedRevision }),
      ),
    );
    expect(both.filter((one) => one.status === 200 && one.code === 'ok')).toHaveLength(1);
    const audit = await h().world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.audit_events
        where subject_record_id = $1 and command = 'task.confirm_delete' and outcome = 'applied'`,
      [task.id],
    );
    expect(audit[0]?.n).toBe('1');
  });

  it('Confirm and Keep at once answer once, and the task matches the answer', async () => {
    const task = await h().freshTask('a task confirmed and kept at once');
    okay(await w.ask(task.id));
    const expectedRevision = await w.revisionOf(task.id);
    const body = { recordId: task.id, expectedRevision };
    const [confirmed, kept] = await Promise.all([
      w.asAdaWide('task.confirm_delete', body),
      w.asAdaWide('task.decline_delete', body),
    ]);
    const applied = [confirmed, kept].filter((one) => one.status === 200 && one.code === 'ok');
    expect(applied, `${confirmed.code} / ${kept.code}`).toHaveLength(1);
    const answers = await h().world.db.admin.execute<{ readonly answer: string }>(
      `select answer from public.task_delete_requests where task_id = $1`,
      [task.id],
    );
    expect(answers).toHaveLength(1);
    const deleted = answers[0]?.answer === 'confirmed';
    expect(await w.readCode(task.id)).toBe(deleted ? 'NOT_FOUND' : 'ok');
  });
});
