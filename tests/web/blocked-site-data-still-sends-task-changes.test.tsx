// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// A browser that blocks site data gives the App no tab storage (`tabStorage()` is null).
// The App's own custodians then keep recovery in memory and still send each change once.
import { expect, it } from 'vitest';
import { pathTo } from '../../apps/web/src/routes.ts';
import { draftTab, type Sent } from './projects-draft-app-support.tsx';
import { realm } from './task-timer-recovery-support.tsx';
import { BoardEditServer, ROW, TASK, key, rename } from './p05-board-edit-support.ts';
import { PERSON, assignmentWorld, chooseAssignment } from './p05-assignment-recovery-support.tsx';
import { world as commentWorld, compose } from './p05-comment-recovery-support.tsx';

const TAB_ONLY = 'Site data is blocked in this browser';

async function blocked(fetch: typeof globalThis.fetch, path: string) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  const app = await realm(fetch, draftTab(), path, null);
  return app;
}

it('with site data blocked, a board rename is sent once and the App says recovery lives in this tab', async () => {
  const world = new BoardEditServer('none');
  const app = await blocked(world.fetch, '/projects/');
  await rename(app, 'Renamed without storage');
  await key(app, ROW + ' input.cbd__rename', 'Enter');
  await app.tick();
  expect(world.writes).toHaveLength(1);
  expect(world.writes[0]?.body).toMatchObject({ recordId: TASK, expectedRevision: 4 });
  expect(app.view.text()).toContain(TAB_ONLY);
  app.view.unmount();
});

it('with site data blocked, an assignment is sent once', async () => {
  const world = assignmentWorld('none');
  const app = await blocked(world.fetch, '/projects/');
  await chooseAssignment(app, 'board', PERSON);
  expect(world.writes).toHaveLength(1);
  expect(world.writes[0]?.body).toMatchObject({ fields: { assignee: PERSON } });
  app.view.unmount();
});

it('with site data blocked, a comment is sent once', async () => {
  const server = commentWorld();
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const request: Sent = {
      path: String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1'),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
    };
    sent.push(request);
    return server.reply(request);
  };
  const app = await blocked(fetch, pathTo('agency:task-detail', { key: 'Recovery-comment' }));
  await compose(app.view);
  await app.tick();
  expect(sent.filter((one) => one.path === '/task/comment')).toHaveLength(1);
  app.view.unmount();
});
