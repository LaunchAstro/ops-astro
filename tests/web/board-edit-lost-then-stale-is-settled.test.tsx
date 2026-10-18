// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// A stored success replays before the revision check, so VERSION_STALE on the retry of a lost
// board edit proves the edit was never stored: the board settles it and the row is free again.
import { expect, it } from 'vitest';
import {
  BoardEditServer,
  ROW,
  SLOT,
  TASK,
  key,
  open,
  rename,
  retry,
} from './p05-board-edit-support.ts';

it('a lost board edit answered VERSION_STALE on retry is settled and the row can be edited again', async () => {
  const world = new BoardEditServer('unreached');
  const app = await open(world);
  await rename(app, 'First words');
  await key(app, ROW + ' input.cbd__rename', 'Enter');
  await app.tick();
  expect(world.writes).toHaveLength(1);
  expect(app.view.text()).toContain('may already have been applied');
  world.advance();
  await retry(app);
  expect(world.writes).toHaveLength(2);
  expect(world.writes[1]).toStrictEqual(world.writes[0]);
  expect(app.view.find(`[data-board-edit-retry="${TASK}"]`)).toBeNull();
  expect(app.storage.getItem(SLOT) ?? '').not.toContain('First words');
  await rename(app, 'Second words');
  await key(app, ROW + ' input.cbd__rename', 'Enter');
  await app.tick();
  expect(world.writes).toHaveLength(3);
  expect(world.writes[2]?.body).toMatchObject({ fields: { title: 'Second words' } });
  expect(world.writes[2]?.body['operationId']).not.toBe(world.writes[0]?.body['operationId']);
  expect(world.applications).toHaveLength(1);
});
