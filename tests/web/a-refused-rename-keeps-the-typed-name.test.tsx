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

type Answer = 'stale' | 'refused' | 'unreachable' | 'hang' | 'ok';

const OTHER = {
  id: '22222222-2222-4222-8222-222222222222',
  key: 'Other-Task',
  title: 'Other task',
};

/** The update's answer; a stored one moves the stored task on. */
function answerUpdate(
  answer: Answer,
  stored: { title: string; revision: number },
  updates: Record<string, unknown>[],
  init?: RequestInit,
): Promise<Response> {
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
    string,
    unknown
  >;
  updates.push(body);
  if (answer === 'stale') {
    stored.revision = 5;
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
  if (answer === 'hang') return new Promise<Response>(() => {});
  const fields = body['fields'] as { title?: string } | undefined;
  Object.assign(stored, { title: fields?.title ?? stored.title, revision: 5 });
  return Promise.resolve(json({ recordId: 'r', revision: 5 }));
}

function serving(answer: Answer) {
  const updates: Record<string, unknown>[] = [];
  // The stored task: a stored rename echoes back; a stale answer means a colleague moved it on.
  const stored = { title: 'Original', revision: 4 };
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
          task: asked.includes(OTHER.key) ? task({ ...OTHER, revision: 2 }) : task(stored),
        }),
      );
    }
    if (where.endsWith('/task/update')) return answerUpdate(answer, stored, updates, init);
    return Promise.resolve(json({ recordId: 'r', revision: 5 }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    updates,
  };
}

const field = (view: { find: (selector: string) => Element | null }) =>
  (view.find('#panel-field-name') as HTMLInputElement | null)?.value;

async function opened(answer: Answer) {
  const { client, updates } = serving(answer);
  let changed = 0;
  const panel = (taskKey = 'Proj-Verity-Pacing', changes = 0) => (
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={{ taskKey, door: 'open', tab: null }}
      changes={changes}
      onChanged={() => {
        changed += 1;
      }}
      onClose={() => {}}
    />
  );
  const view = await mount(panel());
  await tick();
  const reopen = async () => {
    await view.click('[data-panel-field="name"]');
    return field(view);
  };
  const send = async (name: string) => {
    await view.click('[data-panel-field="name"]');
    await typeInto(view, '#panel-field-name', name);
    await press(view, '#panel-field-name', 'Enter');
    await tick();
  };
  return { view, panel, updates, changed: () => changed, reopen, send };
}

async function renameTo(answer: Answer, name: string) {
  const panel = await opened(answer);
  await panel.send(name);
  expect(panel.updates, 'the rename is sent once').toHaveLength(1);
  return { ...panel, typed: await panel.reopen() };
}

describe('a rename the server did not store', () => {
  it.each(['stale', 'refused', 'unreachable'] as const)(
    'answered %s: reopening Rename shows the name the person typed',
    async (answer) => {
      const { typed } = await renameTo(answer, 'The new name');
      expect(typed).toBe('The new name');
    },
  );

  // Sol proof, criterion 1 (S2458-1): an unanswered rename can reopen with its typed name.
  it('a rename with no answer yet reopens on the typed name and sends nothing more', async () => {
    const { typed, view, updates } = await renameTo('hang', 'The new name');
    expect(typed).toBe('The new name');
    await press(view, '#panel-field-name', 'Enter');
    await tick();
    expect(updates, 'nothing more is sent while the first waits').toHaveLength(1);
    expect(field(view), 'the field stays open with the name').toBe('The new name');
  });

  it('a stale refusal asks for a re-read, and the retry goes at the revision read', async () => {
    const { view, panel, updates, changed, reopen, send } = await opened('stale');
    await send('The new name');
    expect(changed(), 'the host is asked to read the task again').toBe(1);
    await view.render(panel(undefined, 1));
    await tick();
    expect(await reopen()).toBe('The new name');
    await press(view, '#panel-field-name', 'Enter');
    await tick();
    expect(updates.map((update) => update['expectedRevision'])).toStrictEqual([4, 5]);
  });
});

describe('a kept name', () => {
  it('Escape drops a kept name', async () => {
    const { view, reopen } = await renameTo('refused', 'The new name');
    await press(view, '#panel-field-name', 'Escape');
    expect(await reopen()).toBe('Original');
  });

  it('the kept name does not reopen on another task in the same panel', async () => {
    const { view, panel } = await renameTo('refused', 'The new name');
    await view.render(panel(OTHER.key));
    await tick();
    expect(view.find('[data-panel-field="name"]')?.textContent).toBe(OTHER.title);
    await view.click('[data-panel-field="name"]');
    expect(field(view)).toBe(OTHER.title);
  });

  it('a stored rename drops the kept name; Rename then opens on the stored title', async () => {
    const { view, panel, changed, reopen, send } = await opened('ok');
    await send('The new name');
    expect(changed()).toBe(1);
    expect(await reopen(), 'before the re-read lands, the title read last').toBe('Original');
    await press(view, '#panel-field-name', 'Escape');
    await view.render(panel(undefined, 1));
    await tick();
    expect(view.find('[data-panel-field="name"]')?.textContent).toBe('The new name');
    expect(await reopen()).toBe('The new name');
  });
});
