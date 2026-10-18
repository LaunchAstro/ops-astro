// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  BoardEditProvider,
  useBoardEdits,
} from '../../apps/web/src/screens/projects/board-edit-context.tsx';
import { BOARD_EDIT_KEY } from '../../apps/web/src/screens/projects/board-edit-attempt.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const RECORD_ID = '10000000-0000-4000-8000-000000000001';

function unknownShapeStorage() {
  const slot = new Map([[BOARD_EDIT_KEY, '{"bogus":1}']]);
  return {
    getItem: (key: string) => slot.get(key) ?? null,
    setItem: (key: string, value: string) => {
      slot.set(key, value);
    },
    removeItem: (key: string) => {
      slot.delete(key);
    },
  };
}

function recordingClient(sent: unknown[]) {
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json({ recordId: RECORD_ID, revision: 5, detail: {} }));
    },
  });
}

function Edit({ client }: { client: OperationsClient }) {
  const { custody } = useBoardEdits(client, 'alpha:reviewer');
  const save = () =>
    custody.choose(
      { command: 'task.update', body: { recordId: RECORD_ID, fields: { title: 'New title' } } },
      4,
    );
  return (
    <button data-edit onClick={save}>
      Save title
    </button>
  );
}

it('a board recovery copy in an unknown shape can be discarded so editing resumes', async () => {
  const storage = unknownShapeStorage();
  const sent: unknown[] = [];
  const client = recordingClient(sent);
  const view = await mount(
    <BoardEditProvider client={client} grantKey="alpha:reviewer" storage={storage}>
      <Edit client={client} />
    </BoardEditProvider>,
  );
  expect(view.find('[data-board-edit-problem]')?.textContent).toContain('could not be recovered');
  await view.click('[data-edit]');
  await tick();
  expect(sent).toHaveLength(0);
  const discard = view
    .all('button')
    .find((button) =>
      /discard.*(?:unreadable|recovery|saved).*copy/iu.test(button.textContent ?? ''),
    );
  expect(
    discard,
    'the recovery alert must offer a way to discard the unreadable copy',
  ).toBeDefined();
  await act(() => (discard as HTMLElement).click());
  expect(storage.getItem(BOARD_EDIT_KEY)).toBeNull();
  expect(view.find('[data-board-edit-problem]')).toBeNull();
  await view.click('[data-edit]');
  await tick();
  expect(sent).toHaveLength(1);
});
