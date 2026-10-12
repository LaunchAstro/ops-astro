// SPDX-License-Identifier: AGPL-3.0-only
//
// A waiting launch keys to its task with no cascade (`task_launches`), so the
// purge keeps a launched task like any other the runtime still holds, and
// purges the rest. Deleting it would fault on the key and roll back the
// purge of every other aged task with it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  installBusinessSettings,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { codeOf, detailOf } from './agent-fixture.ts';
import { grantTo } from './fixture.ts';
import {
  aiWorld,
  assign,
  created,
  launch,
  ownedAgent,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';

const APPLIED = 'not-a-refusal';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) {
  console.warn('purge keeps a launched task: DATABASE_URL is unset, so nothing ran.');
}

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await aiWorld('purgelaunch');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.p, 'manage');
    await installBusinessSettings(tx);
    const written = await writeBusinessSetting(tx, {
      key: 'retention_window_days',
      owningOperation: 'settings.set_retention_window',
      value: 0,
    });
    if (written === undefined || 'refused' in written) throw new Error('window not written');
  });
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** Trash a task by the command, then age it an hour so a zero window takes it. */
const trashed = async (taskId: string): Promise<void> => {
  const answer = await w.world.asPerson(w.p, {
    command: 'task.trash',
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision: await revisionOf(w, taskId),
  });
  expect(codeOf(answer)).toBe(APPLIED);
  await w.world.db.admin.execute(
    `update public.records set deleted_at = deleted_at - interval '1 hour' where id = $1`,
    [taskId],
  );
};

const present = async (ids: readonly string[]): Promise<readonly string[]> =>
  (
    await w.world.db.admin.execute<{ readonly id: string }>(
      `select id::text as id from public.records where id = any ($1::uuid[]) order by id`,
      [ids],
    )
  ).map((row) => row.id);

describe.skipIf(serverUrl === undefined)('Purge: a launched task stays with its launch', () => {
  it('keeps the launched task, reports it retained, and purges the plain one', async () => {
    const agent = await ownedAgent(w, w.p);
    const launched = await created(w, w.p, 'Launched, then trashed');
    expect(codeOf(await assign(w, w.p, launched, { agent }))).toBe(APPLIED);
    expect(await launch(w, w.p, launched)).toBe(APPLIED);
    const plain = await created(w, w.p, 'Plain, then trashed');
    await trashed(launched);
    await trashed(plain);

    const purge = await w.world.asPerson(w.p, {
      command: 'task.purge',
      operationId: randomUUID(),
    });
    expect(codeOf(purge)).toBe(APPLIED);
    expect(detailOf(purge)).toMatchObject({ purgedIds: [plain], retained: [launched] });
    expect(await present([launched, plain])).toEqual([launched]);
  });
});
