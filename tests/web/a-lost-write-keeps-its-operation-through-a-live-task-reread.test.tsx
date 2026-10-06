// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, unicorn/no-array-callback-reference -- the review's proof, kept as written */
//
// #461: a subtask or time log whose answer was lost keeps its operation id
// through a live task reread, so the retry of the same request is the same
// write and the server keeps one record. Drives the real task page, a live
// invalidation, the production command register and migrated Postgres.
// Moved from the review's proof (F2-FIX3) with its body unchanged.
import { act } from 'react';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { timeWorld, type TimeWorld } from '../commands/time-world.ts';
import { press } from './perspective-support.tsx';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'a-lost-write-keeps-its-operation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let world: TimeWorld;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await timeWorld('lostwriteop');
}, 60_000);
afterAll(async () => {
  await world?.db.drop();
});

it.skipIf(serverUrl === undefined).each([
  { kind: 'subtask', path: '/task/create', selector: '[data-step-add]', typed: 'One child' },
  { kind: 'time log', path: '/time/log', selector: '[data-time-log]', typed: '30m' },
])(
  'a lost $kind answer keeps its operation through a live task reread',
  async ({ kind, path, selector, typed }) => {
    const taskId = await world.fresh(world.alpha, world.ada, `Unknown ${kind} attempt`);
    const identities: unknown[] = [];
    const count = async () => {
      const rows = await world.db.admin.execute<{ n: number }>(
        kind === 'time log'
          ? 'select count(*)::int as n from public.time_entries where task_id = $1'
          : "select count(*)::int as n from public.records where data ->> 'parent' = $1",
        [taskId],
      );
      return rows[0]?.n;
    };
    let invalidate: (() => void) | undefined;
    let finishRead: (() => void) | undefined;
    let reads = 0;
    let answeredWrites = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/live?')) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              invalidate = () =>
                controller.enqueue(
                  new TextEncoder().encode(`event: invalidate\ndata: task:${taskId}\n\n`),
                );
            },
          }),
        );
      }
      if (url.endsWith('/task/read')) {
        reads += 1;
        if (reads === 2)
          await new Promise<void>((resolve) => {
            finishRead = resolve;
          });
        const read = await executeRead(world.db.app, world.alpha, world.ada.presented, {
          read: 'task.read',
          recordId: taskId,
        });
        if (isCommandRefusal(read)) throw new Error(`Proof setup read refused: ${read.code}`);
        return Response.json(read);
      }
      if (url.endsWith(path)) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        identities.push(body['operationId']);
        // Run the production command and register on migrated Postgres before losing the answer.
        const result = await world.as(world.alpha, world.ada, {
          ...body,
          command: kind === 'subtask' ? 'task.create' : 'time.log',
        });
        answeredWrites += 1;
        if (isCommandRefusal(result)) throw new Error(`Proof setup write refused: ${result.code}`);
        if (identities.length === 1) throw new TypeError('Response lost after commit');
        return Response.json(result);
      }
      return Response.json({ persons: [], preferences: {}, items: [] });
    };
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const page = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey={taskId} />,
    );
    try {
      await vi.waitFor(() => expect(page.find(selector)).not.toBeNull());
      await vi.waitFor(() => expect(invalidate).toBeTypeOf('function'));
      await page.type(selector, typed);
      await press(page, selector, 'Enter');
      await vi.waitFor(() => expect(page.text()).toContain('Response lost after commit'));
      expect(await count()).toBe(1);
      // The channel remains healthy and reports a change while this write's outcome is unknown.
      await act(async () => {
        invalidate?.();
        await Promise.resolve();
      });
      expect(reads).toBe(2);
      await act(async () => {
        finishRead?.();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(page.find(selector)).not.toBeNull());
      // Retry the exact same request after the page finishes rereading.
      await page.type(selector, typed);
      await press(page, selector, 'Enter');
      await vi.waitFor(() => expect(answeredWrites).toBe(2));
      await settle();
      expect(identities).toHaveLength(2);
      await vi.waitFor(() => expect(page.find(selector)).not.toBeNull());
      expect(
        await count(),
        'The live reread discarded an unresolved operation and the retry made a second effect',
      ).toBe(1);
      expect(identities[1]).toBe(identities[0]);
    } finally {
      finishRead?.();
      await page.unmount();
    }
  },
  30_000,
);
