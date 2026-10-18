// SPDX-License-Identifier: AGPL-3.0-only
//
// #1710: a launch past its bound, read as `unanswered`, is shown to nobody
// the task read does not admit: another business and a person with no grant
// on the task see no agent and no run. From Sol's review of 7f17a06.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { aiWorld, type AiWorld } from './ai-assign-world.ts';
import { launchedTask } from './take-launch-world.ts';
import { readBoardAgents } from '../../packages/core-commands/src/reads/board-agents.ts';
import { insertBusiness } from '../identity/fixture.ts';
const it = vitestIt.skipIf(databaseUrlFromEnvironment() === undefined);

let w: AiWorld;
let task: string;
beforeAll(async () => {
  if (databaseUrlFromEnvironment() === undefined) return;
  w = await aiWorld('unanswersep');
  task = await launchedTask(w, 'Do not disclose this launch');
  await w.world.db.admin.execute(
    "update public.task_launches set launched_at = launched_at - interval '16 minutes' where task_id = $1",
    [task],
  );
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});
it('another business cannot read the unanswered launch', async () => {
  const other = await insertBusiness(w.world.db.app, `other-${randomUUID()}`);
  const result = await w.world.db.app.withBusiness(
    other,
    async (tx) => await readBoardAgents(tx, [task], randomUUID(), null),
  );
  expect(result.get(task)?.agent).toBeNull();
});
it('an ungranted person cannot read the unanswered launch', async () => {
  const person = randomUUID();
  const result = await w.world.db.app.withBusiness(
    w.world.business,
    async (tx) => await readBoardAgents(tx, [task], person, [{ kind: 'person', id: person }]),
  );
  expect(result.get(task)?.agent).toBeNull();
});
