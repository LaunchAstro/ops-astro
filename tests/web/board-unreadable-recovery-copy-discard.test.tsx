// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// A recovery copy the board cannot read (here, one left by a departed owner) pauses board
// edits until the person discards it. Discard removes only the exact copy it read, and only
// for the owner that read it.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { BoardEditCustody } from '../../apps/web/src/screens/projects/board-edit-custody.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { draftTab } from './projects-draft-app-support.tsx';
import { BoardEditServer, ROW, SLOT, TASK, key, open, rename } from './p05-board-edit-support.ts';

const DEPARTED = 'alpha:draft-entry@example.test:0';
const DISCARD = '[data-board-edit-discard]';
const noRequest = () => Promise.reject(new Error('Discard sends no request'));

function departedCopy(operationId = '22222222-2222-4222-8222-222222222222'): string {
  return JSON.stringify({
    version: 1,
    owner: DEPARTED,
    tasks: {
      [TASK]: {
        attempt: {
          command: 'task.complete',
          body: { recordId: TASK },
          operationId,
          expectedRevision: 4,
        },
        knowledge: 'unresolved',
      },
    },
  });
}

/** The same person signed in again: a later session generation than the copy's owner. */
function tabWithDepartedCopy(): Storage {
  const tab = draftTab();
  tab.setItem('ops-astro.session-endings', '2');
  tab.setItem(SLOT, departedCopy());
  return tab;
}

async function renameRow(app: Awaited<ReturnType<typeof open>>, text: string) {
  await rename(app, text);
  await key(app, ROW + ' input.cbd__rename', 'Enter');
  await app.tick();
}

it('a departed owner copy pauses board edits until Discard, then the next edit is sent', async () => {
  const world = new BoardEditServer('none');
  const app = await open(world, tabWithDepartedCopy());
  expect(app.view.text()).toContain('could not be recovered');
  await renameRow(app, 'Paused words');
  expect(world.writes).toHaveLength(0);
  expect(app.view.find(DISCARD), 'the person needs a way past the unreadable copy').not.toBeNull();
  await app.view.click(DISCARD);
  expect(app.storage.getItem(SLOT)).toBeNull();
  expect(app.view.find('[data-board-edit-problem]')).toBeNull();
  // The refused rename is still open in its row; pressing Enter again now sends it.
  await key(app, ROW + ' input.cbd__rename', 'Enter');
  await app.tick();
  expect(world.writes).toHaveLength(1);
  expect(world.writes[0]?.body).toMatchObject({ fields: { title: 'Paused words' } });
});

it('Discard keeps a recovery copy that changed after the board read it', async () => {
  const world = new BoardEditServer('none');
  const app = await open(world, tabWithDepartedCopy());
  const replaced = departedCopy('33333333-3333-4333-8333-333333333333');
  app.storage.setItem(SLOT, replaced);
  await app.view.click(DISCARD);
  expect(app.storage.getItem(SLOT)).toBe(replaced);
  expect(app.view.text()).toContain('was not discarded');
  await renameRow(app, 'Still paused');
  expect(world.writes).toHaveLength(0);
});

it('Discard does nothing once the owner that read the copy has changed', () => {
  const tab = tabWithDepartedCopy();
  const raw = tab.getItem(SLOT);
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: noRequest,
  });
  const custody = new BoardEditCustody(client, 'alpha:draft-entry@example.test:2', tab);
  custody.activate();
  expect(custody.snapshot().problem).not.toBeNull();
  new SessionStore(tab).clear();
  custody.discard();
  expect(tab.getItem(SLOT)).toBe(raw);
  expect(custody.snapshot().problem).not.toBeNull();
});
