// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The same as the mounted case, against the real command envelope on a
// migrated database: the stored note is the one saved last.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { TaskTimeView } from '../../packages/core-wire/src/index.ts';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { entryIdOf, timeWorld, type TimeWorld } from '../commands/time-world.ts';
import { json, mount, press } from './perspective-support.tsx';

/** The production client, its note requests run through the command envelope; the first answer is lost after it commits. */
function noteClient(world: TimeWorld, entryId: string, operationIds: string[]): OperationsClient {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (_url, init) => {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      if (
        typeof body !== 'object' ||
        body === null ||
        !('entryId' in body) ||
        body.entryId !== entryId ||
        !('note' in body) ||
        typeof body.note !== 'string' ||
        !('operationId' in body) ||
        typeof body.operationId !== 'string'
      )
        throw new Error('Invalid note request');
      operationIds.push(body.operationId);
      const result = await executeCommand(world.db.app, world.alpha, world.ada.presented, 'api', {
        command: 'time.set_note',
        entryId,
        note: body.note,
        operationId: body.operationId,
      });
      if (isCommandRefusal(result)) throw new Error('Unexpected refusal ' + result.code);
      if (operationIds.length === 1) throw new Error('Note response lost after commit');
      return json(result);
    },
  });
}

/** The task's time log, mounted as the task page shows it. */
const mountLog = (client: OperationsClient, taskId: string, time: TaskTimeView) =>
  mount(
    <TimeLog
      client={client}
      taskId={taskId}
      time={time}
      estimateMinutes={null}
      showAll={false}
      onShowAll={() => {}}
      onChanged={() => {}}
    />,
  );

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a time note saved again against the database',
  () => {
    let world: TimeWorld;
    beforeAll(async () => {
      world = await timeWorld('noteintent');
    }, 180_000);
    afterAll(async () => {
      await world?.db.drop();
    });

    it('a later note intent does not replay an obsolete database receipt', async () => {
      const taskId = await world.fresh(world.alpha, world.ada, 'Note intent recovery');
      const logged = await world.as(world.alpha, world.ada, {
        command: 'time.log',
        taskId,
        duration: '30m',
        note: 'Original',
      });
      const entryId = entryIdOf(logged);
      const { time } = await world.timeOf(world.alpha, world.ada, taskId);
      if (time === null) throw new Error('Missing filed entry');
      const operationIds: string[] = [];
      const client = noteClient(world, entryId, operationIds);
      const view = await mountLog(client, taskId, time);
      const box = 'input[data-time-note-edit]';
      await view.click(`[data-time-note="${entryId}"]`);
      await view.type(box, 'First note');
      await press(view, box, 'Enter');
      await expect
        .poll(() => view.find('[role="alert"]')?.textContent)
        .toContain('Note response lost after commit');
      expect((await world.entries(taskId))[0]?.note).toBe('First note');
      await view.type(box, 'Second note');
      await press(view, box, 'Enter');
      await expect.poll(() => view.find('input[data-time-note-edit]')).toBeNull();
      expect((await world.entries(taskId))[0]?.note).toBe('Second note');
      await view.click(`[data-time-note="${entryId}"]`);
      await view.type(box, 'First note');
      await press(view, box, 'Enter');
      await expect.poll(() => view.find('input[data-time-note-edit]')).toBeNull();
      expect(
        (await world.entries(taskId))[0]?.note,
        'a later deliberate save must apply First note again',
      ).toBe('First note');
    });
  },
);
