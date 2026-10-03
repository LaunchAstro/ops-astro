// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { timeWorld, type TimeWorld } from '../commands/time-world.ts';
import { json, mount, typeInto, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

let w: TimeWorld;
beforeAll(async () => {
  w = await timeWorld('solow093');
}, 180_000);
afterEach(unmountAll);
afterAll(async () => {
  await w?.db.drop();
});

// Sol OW-093.1 criterion 5, retitled by what it proves; its body is Sol's.
it('retrying a committed time log after a lost response stores one entry', async () => {
  const taskId = await w.fresh(w.alpha, w.ada, 'Lost time-log response');
  const operationIds: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (_url, init) => {
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      if (
        typeof body !== 'object' ||
        body === null ||
        !('operationId' in body) ||
        typeof body.operationId !== 'string' ||
        !('duration' in body) ||
        typeof body.duration !== 'string'
      )
        throw new Error('invalid time-log body');
      operationIds.push(body.operationId);
      const result = await executeCommand(w.db.app, w.alpha, w.ada.presented, 'api', {
        command: 'time.log',
        taskId,
        duration: body.duration,
        operationId: body.operationId,
      });
      if (isCommandRefusal(result)) throw new Error(`unexpected refusal ${result.code}`);
      // The real transaction committed before the transport loses its answer.
      if (operationIds.length === 1) throw new Error('response lost after commit');
      return json(result);
    },
  });
  const view = await mount(
    <TimeLog
      client={client}
      taskId={taskId}
      time={{ entries: [], running: null, totalMinutes: 0 }}
      estimateMinutes={null}
      showAll={false}
      onShowAll={() => {}}
      onChanged={() => {}}
    />,
  );
  await typeInto(view, 'input[data-time-log]', '30m');
  await view.click('[data-time-log-add]');
  await expect
    .poll(() => view.find('[role="alert"]')?.textContent)
    .toContain('response lost after commit');
  expect(await w.entries(taskId)).toHaveLength(1);
  await view.click('[data-time-log-add]');
  await expect.poll(() => operationIds.length).toBe(2);
  await expect.poll(() => view.find('[data-time-log-add]')?.hasAttribute('disabled')).toBe(false);
  await tick();
  expect((await w.entries(taskId)).map((row) => row.minutes)).toStrictEqual([30]);
});
