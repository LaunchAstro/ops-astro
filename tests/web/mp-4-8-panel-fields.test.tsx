// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8, the dock task panel's field edits: the name, the assignee and the
// due date, each through the task's own command (`task.update` for the name
// and the due date, `task.assign` for the assignee) at the revision the panel
// read. Estimate, category, stage, board, state, Assign to AI and the client
// wait on other owners (the handback's LEANS-ON line); the server side of these
// edits (refusals, audit, isolation) is tests/commands/task-panel-fields.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, tabStorage } from '../../apps/web/src/session/token.ts';
import { TASK_ID, task, tick } from './task-page-stub.tsx';
import { json, mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { KEY, PEOPLE, panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

describe('MP-4-8 rename updates everywhere', () => {
  it('the name is changed in place through task.update at the read revision, and the host rereads', async () => {
    const { client, sent } = serving();
    let changed = 0;
    const view = await panel(client, { changed: () => (changed += 1) });
    await view.click('[data-panel-field="name"]');
    await typeInto(view, '#panel-field-name', 'Budget pacing fix, round two');
    await press(view, '#panel-field-name', 'Enter');
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('/task/update');
    expect(sent[0]?.body).toMatchObject({
      recordId: TASK_ID,
      expectedRevision: 4,
      fields: { title: 'Budget pacing fix, round two' },
    });
    expect(changed).toBe(1);
    await view.unmount();
  });

  it('an unchanged or blank name sends nothing', async () => {
    const { client, sent } = serving();
    const view = await panel(client);
    await view.click('[data-panel-field="name"]');
    await press(view, '#panel-field-name', 'Enter');
    await view.click('[data-panel-field="name"]');
    await typeInto(view, '#panel-field-name', '   ');
    await press(view, '#panel-field-name', 'Enter');
    await tick();
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });
});

describe('MP-4-8 assignee reads back', () => {
  it('lists the real people and Unassigned, and draws the task’s assignee as chosen', async () => {
    const view = await panel(serving({ assignee: PEOPLE[1] }).client);
    const select = view.find('#panel-field-assignee') as HTMLSelectElement | null;
    expect([...(select?.options ?? [])].map((option) => option.text)).toStrictEqual([
      'Unassigned',
      'Ada',
      'Grace',
    ]);
    expect(select?.value).toBe('p-grace');
    await view.unmount();
  });

  it('with nobody assigned the select reads Unassigned', async () => {
    const view = await panel(serving().client);
    expect((view.find('#panel-field-assignee') as HTMLSelectElement | null)?.value).toBe('');
    await view.unmount();
  });

  it('a person and Unassigned each go through task.assign at the read revision', async () => {
    const { client, sent } = serving({ assignee: PEOPLE[1] });
    const view = await panel(client);
    await view.choose('#panel-field-assignee', 'p-ada');
    await tick();
    await view.choose('#panel-field-assignee', '');
    await tick();
    expect(
      sent.map((each) => [each.to, each.body['fields'], each.body['expectedRevision']]),
    ).toStrictEqual([
      ['/task/assign', { assignee: 'p-ada' }, 4],
      ['/task/assign', { assignee: null }, 4],
    ]);
    await view.unmount();
  });
});

describe('MP-4-8 escape closes only the control', () => {
  it('Escape in the assignee select closes nothing', async () => {
    let closed = 0;
    const view = await panel(serving().client, { close: () => (closed += 1) });
    await press(view, '#panel-field-assignee', 'Escape');
    expect(closed).toBe(0);
    await view.unmount();
  });

  it('Escape in the date picker closes the picker, never the panel', async () => {
    let closed = 0;
    const { client, sent } = serving();
    const view = await panel(client, { close: () => (closed += 1) });
    await view.click('[data-panel-field="due"]');
    await press(view, '[data-date-picker] [role="grid"]', 'Escape');
    expect(view.find('[data-date-picker]')).toBeNull();
    expect(closed).toBe(0);
    await view.click('[data-panel-field="due"]');
    await press(view, '[data-picker="next"]', 'Escape');
    expect(view.find('[data-date-picker]')).toBeNull();
    expect(closed).toBe(0);
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });

  it('Escape in the name edit ends the edit, keeps the name and closes nothing', async () => {
    let closed = 0;
    const { client, sent } = serving();
    const view = await panel(client, { close: () => (closed += 1) });
    await view.click('[data-panel-field="name"]');
    await typeInto(view, '#panel-field-name', 'half typed');
    await press(view, '#panel-field-name', 'Escape');
    expect(view.find('#panel-field-name')).toBeNull();
    expect(view.find('[data-panel-field="name"]')?.textContent).toContain('Budget pacing fix');
    expect(closed).toBe(0);
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });
});

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

/** Mia's own time on the task: one logged entry. */
const MIAS_TIME = {
  entries: [
    {
      id: 'e-1',
      startedAt: '2026-09-30T01:00:00.000Z',
      endedAt: '2026-09-30T01:45:00.000Z',
      minutes: 45,
      note: '',
      adHoc: false,
      source: 'log',
    },
  ],
  running: null,
  totalMinutes: 45,
};

/** The server for the whole application: `session.person` names Mia Hart. */
const asMia = ((url: string | URL) => {
  const where = String(url);
  const answers: Readonly<Record<string, unknown>> = {
    '/session/person': { ok: true, person: { name: 'Mia Hart' } },
    '/task/read': { ok: true, task: task({ time: MIAS_TIME }) },
    '/person/list': { ok: true, persons: PEOPLE },
    '/preference/read': { ok: true, preferences: {} },
    '/task/queue': { ok: true, queue: [], alerts: [], outages: [] },
    '/task/board': { ok: true, tasks: [] },
    '/client/list': { ok: true, clients: [] },
  };
  const path = Object.keys(answers).find((end) => where.endsWith(end));
  if (path !== undefined) return Promise.resolve(json(answers[path]));
  // The tab's one live stream (C4) is unavailable; anything else is refused.
  if (/\/live(\/task\/|\?|$)/u.test(where)) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return Promise.resolve(json({ ok: false }));
}) as unknown as typeof globalThis.fetch;

/** The whole application signed in as Mia, the task panel opened from the page's time door. */
async function signedInAsMia() {
  const session = JSON.stringify({ token: 't', businessKey: 'alpha', email: 'mia@alpha.local' });
  const seed = new Map([['ops-astro.session', session]]);
  const sessions = new SessionStore({
    getItem: (key) => seed.get(key) ?? null,
    setItem: (key, value) => void seed.set(key, value),
    removeItem: (key) => void seed.delete(key),
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
  const view = await mount(
    <App
      path={`/task/${KEY}`}
      navigate={ignore}
      sessions={sessions}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={asMia}
      storage={tabStorage()}
    />,
  );
  await tick();
  await view.click('#perspective-panel-team [data-panel-door="log"]');
  await tick();
  return view;
}

describe('MP-4-8 viewer is the signed-in person', () => {
  it('the panel’s own time entries name the signed-in person, never a fixed name', async () => {
    const view = await signedInAsMia();
    const entry = view.find('[data-task-panel] [data-time-entry="e-1"]');
    expect(entry?.textContent).toContain('Mia Hart');
    expect(view.find('[data-task-panel]')?.textContent).not.toContain('Nathan');
    await view.unmount();
  });
});
