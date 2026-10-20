// SPDX-License-Identifier: AGPL-3.0-only
//
// A launch taken to answer runs under its own delegation, and the server holds
// it to reading its task and that delegation (the whole matrix is
// `tests/api/a-taken-launch-reads-its-own-delegation-picks-up-its-task-and-is-refused-the-rest.test.ts`):
// a comment, an update or a proposal under that
// credential is refused `DELEGATION_EXCLUDES_OPERATION` and writes nothing,
// whatever the delegation's actions would allow. A launch's credential used
// before any take keeps the actions it was minted with, so a proposal still
// goes through.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from './agent-fixture.ts';
import { aiWorld, revisionOf, type AiWorld } from './ai-assign-world.ts';
import { APPLIED, derivedFor, launchOf, launchedTask, take, takenAs } from './take-launch-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('taken launch: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('takenlaunch');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

const proposal = async (taskId: string) => ({
  command: 'task.propose',
  operationId: randomUUID(),
  recordId: taskId,
  expectedRevision: await revisionOf(w, taskId),
  purpose: `run_${randomUUID().slice(0, 8)}`,
  maximumMinor: 3_000,
  currency: 'AUD',
  payload: { instruction: 'draft a reply' },
  step: { kind: 'compose', payload: {} },
});

/** What a write would leave: the business's records (a comment is one), the task's proposals and its revision. */
const footprint = async (taskId: string) =>
  (
    await w.world.db.admin.execute<{ records: number; lineages: number; revision: string }>(
      `select (select count(*)::int from public.records c
                where c.business_id = r.business_id) as records,
              (select count(*)::int from public.proposal_lineages p
                where p.business_id = r.business_id and p.task_id = r.id) as lineages,
              r.revision::text as revision
         from public.records r where r.id = $1`,
      [taskId],
    )
  )[0];

/** Each case, run only against a database. */
const live = it.skipIf(serverUrl === undefined);

live(
  'reads its task, and a comment, an update or a proposal under it is refused and writes nothing',
  async () => {
    const task = await launchedTask(w, 'Answer, and nothing else');
    const launched = await launchOf(w, task);
    const credential = String(takenAs(await take(w, launched.id))['credential']);
    const before = await footprint(task);

    const read = await w.world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: task },
      credential,
    );
    const comment = await w.world.asAgent(
      {
        command: 'task.comment',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: await revisionOf(w, task),
        body: 'Written outside the run',
        audience: 'internal',
      },
      credential,
    );
    const update = await w.world.asAgent(
      {
        command: 'task.update',
        operationId: randomUUID(),
        recordId: task,
        expectedRevision: await revisionOf(w, task),
        fields: { title: 'Renamed by the run' },
      },
      credential,
    );
    const proposed = await w.world.asAgent(await proposal(task), credential);

    expect({
      read: codeOf(read),
      comment: codeOf(comment),
      update: codeOf(update),
      proposed: codeOf(proposed),
      after: await footprint(task),
    }).toStrictEqual({
      read: APPLIED,
      comment: 'DELEGATION_EXCLUDES_OPERATION',
      update: 'DELEGATION_EXCLUDES_OPERATION',
      proposed: 'DELEGATION_EXCLUDES_OPERATION',
      after: before,
    });
  },
);

live('a launch’s credential before any take keeps the actions it was minted with', async () => {
  const task = await launchedTask(w, 'Not taken, still proposes');
  const launched = await launchOf(w, task);

  const proposed = await w.world.asAgent(await proposal(task), await derivedFor(w, launched.id));

  expect(codeOf(proposed)).toBe(APPLIED);
});
