// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A budget top-up (T2e) is one attempt until its answer is known. The real
// task page sends it through the production client to the production command
// register on a migrated database; the top-up commits and its answer is lost.
// The page reads the task again and shows the raised maximum, and the next
// press sends that same attempt, under its first operation id and with its
// first figures, so the register answers it as the top-up already made and
// the envelope is raised once, not twice.

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { mount, settle } from '../surfaces/mount.tsx';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { MAXIMUM, SMALL, openTopUpWorld, type TopUpWorld } from '../runtime/t2e-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('a top-up whose answer was lost: DATABASE_URL is unset, so nothing below ran.');
}

let world: TopUpWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await openTopUpWorld('topuplost');
}, 180_000);
afterAll(async () => {
  await world?.s.db.drop();
});

/** The page's API: the production read and command entries, the first top-up's answer lost. */
function api(taskId: string) {
  const { s } = world;
  const sent: Readonly<Record<string, unknown>>[] = [];
  const answered: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/task/read')) {
      const read = await executeRead(s.db.app, s.business, s.decider.presented, {
        read: 'task.read',
        recordId: taskId,
      });
      if (isCommandRefusal(read)) throw new Error(`the task read was refused: ${read.code}`);
      return Response.json(read);
    }
    if (url.endsWith('/budget/top_up')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      const result = await world.as(s.decider, { ...body, command: 'budget.top_up' });
      answered.push(result);
      if (isCommandRefusal(result)) throw new Error(`the top-up was refused: ${result.code}`);
      if (sent.length === 1) throw new TypeError('The answer was lost after the commit');
      return Response.json(result);
    }
    return Response.json({ persons: [], preferences: {}, items: [] });
  };
  return { fetch, sent, answered };
}

it.skipIf(serverUrl === undefined)(
  'a top-up whose answer was lost resends as the same attempt after the reread shows the raised maximum',
  async () => {
    const { taskId } = await world.planned();
    const server = api(taskId);
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: server.fetch,
    });
    const page = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:decider" taskKey={taskId} />,
    );
    const raised = (MAXIMUM + SMALL) / 100;
    try {
      await vi.waitFor(() => expect(page.find('[data-top-up="submit"]')).not.toBeNull());
      await page.type('#top-up-amount', String(SMALL / 100));
      await page.click('[data-top-up="submit"]');
      await vi.waitFor(() =>
        expect(page.find('[data-top-up="envelope"]')?.textContent).toContain(raised.toFixed(2)),
      );
      expect(await world.maximumOf(taskId)).toBe(MAXIMUM + SMALL);

      await page.type('#top-up-amount', String(SMALL / 100));
      await page.click('[data-top-up="submit"]');
      await vi.waitFor(() => expect(server.answered).toHaveLength(2));
      await settle();
      expect(
        await world.maximumOf(taskId),
        'one durable top-up: the retry did not raise it again',
      ).toBe(MAXIMUM + SMALL);
      expect(server.sent[1], 'the retry is the first attempt, id and figures').toStrictEqual(
        server.sent[0],
      );
    } finally {
      await page.unmount();
    }
  },
  60_000,
);
