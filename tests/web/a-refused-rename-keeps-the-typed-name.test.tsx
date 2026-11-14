// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1456: Enter closes the rename and sends the new name. When the save is
// refused or never answered, the name the person typed comes back the next
// time they open Rename, and a stale refusal asks the host to read the task
// again, so the retry goes at the revision now stored.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, press, typeInto, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

type Answer = 'stale' | 'refused' | 'unreachable' | 'ok';

const OTHER = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'Other-Task',
  title: 'Other task',
};

function serving(answer: Answer) {
  const updates: Record<string, unknown>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (/\/live(\/task\/|\?|$)/u.test(where)) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/task/read')) {
      const asked = String(init?.body ?? '');
      return Promise.resolve(
        json({
          ok: true,
          task: asked.includes(OTHER.key)
            ? task({ ...OTHER, revision: 2 })
            : task({ title: 'Original', revision: 4 }),
        }),
      );
    }
    if (where.endsWith('/task/update')) {
      updates.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
      );
      if (answer === 'stale') {
        return Promise.resolve(
          json({ refused: true, code: 'VERSION_STALE', names: [], fixes: [] }, 409),
        );
      }
      if (answer === 'refused') {
        return Promise.resolve(
          json({ refused: true, code: 'FIELD_INVALID', names: ['title'], fixes: [] }, 422),
        );
      }
      if (answer === 'unreachable') return Promise.reject(new TypeError('network down'));
    }
    return Promise.resolve(json({ recordId: 'r', revision: 5 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    updates,
  };
}

async function renameTo(answer: Answer, name: string) {
  const { client, updates } = serving(answer);
  let changed = 0;
  const panel = (taskKey: string) => (
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={{ taskKey, door: 'open', tab: null }}
      changes={0}
      onChanged={() => {
        changed += 1;
      }}
      onClose={() => {}}
    />
  );
  const view = await mount(panel('Proj-Verity-Pacing'));
  await tick();
  await view.click('[data-panel-field="name"]');
  await typeInto(view, '#panel-field-name', name);
  await press(view, '#panel-field-name', 'Enter');
  await tick();
  expect(updates, 'the rename is sent once').toHaveLength(1);
  await view.click('[data-panel-field="name"]');
  const typed = (view.find('#panel-field-name') as HTMLInputElement | null)?.value;
  return { typed, changed: () => changed, view, panel };
}

describe('a rename the server did not store', () => {
  it.each(['stale', 'refused', 'unreachable'] as const)(
    'answered %s: reopening Rename shows the name the person typed',
    async (answer) => {
      const { typed } = await renameTo(answer, 'The new name');
      expect(typed).toBe('The new name');
    },
  );

  it('a stale refusal asks for the task to be read again', async () => {
    const { changed } = await renameTo('stale', 'The new name');
    expect(changed()).toBe(1);
  });

  it('the kept name does not reopen on another task in the same panel', async () => {
    const { view, panel } = await renameTo('refused', 'The new name');
    await view.render(panel(OTHER.key));
    await tick();
    expect(view.find('[data-panel-field="name"]')?.textContent).toBe(OTHER.title);
    await view.click('[data-panel-field="name"]');
    expect((view.find('#panel-field-name') as HTMLInputElement | null)?.value).toBe(OTHER.title);
  });

  it('a stored rename opens next time on the stored title, not the typed one', async () => {
    const { typed, changed } = await renameTo('ok', 'The new name');
    expect(changed()).toBe(1);
    expect(typed).toBe('Original');
  });
});
