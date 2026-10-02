// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8, the dock task panel's folded trail (MP-4-16, `preference saved`):
// whether the trail shows is the person's own key in the one preference
// store, `history.showTrail`, read once and saved on each change, as show
// finished is (mp-4-4-show-finished). The server side, that the key is the
// caller's own and no one else's, is tests/api/history-trail-preference.

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

const KEY = 'Proj-Verity-Pacing';
const TRAIL = '[data-task-panel] [data-history="trail"] .sbact__row';
const FOLD = '[data-task-panel] [data-history-fold]';

const ignore = (): void => {
  /* The case reads nothing from this call. */
};

const change = (minutesAgo: number, operation: string) => ({
  at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  actorId: 'actor-ada',
  actorName: 'Ada',
  actorKind: 'person',
  operation,
});

const history = [change(90, 'task.create'), change(60, 'task.update'), change(30, 'task.assign')];

/** A server answering one task with three changes; `stored` answers `preference.read`. */
function serving(stored: () => Response | Promise<Response>) {
  const saves: Readonly<Record<string, unknown>>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/preference/read')) return Promise.resolve(stored());
    if (where.endsWith('/preference/save')) {
      saves.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as never);
    }
    if (where.endsWith('/task/read'))
      return Promise.resolve(json({ ok: true, task: task({ history }) }));
    if (where.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (where.endsWith('/task/board')) return Promise.resolve(json({ ok: true, tasks: [] }));
    if (where.endsWith('/client/list')) return Promise.resolve(json({ ok: true, clients: [] }));
    if (/\/live(\/task\/|\?|$)/u.test(where))
      return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(json({ ok: true, recordId: null, revision: null }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, saves };
}

const storing = (preferences: Readonly<Record<string, unknown>>) => () =>
  json({ ok: true, preferences });

const panel = (client: OperationsClient, changes = 0) => (
  <TaskPanel
    client={client}
    grantKey="alpha:member"
    opening={{ taskKey: KEY, door: 'open', tab: null }}
    changes={changes}
    onChanged={ignore}
    onClose={ignore}
  />
);

describe('MP-4-8 trail fold is the person’s own preference', () => {
  it('a stored open fold opens the trail on arrival, and each change is saved as the person’s own key', async () => {
    const { client, saves } = serving(storing({ 'history.showTrail': true }));
    const view = await mount(panel(client));
    await tick();
    expect(view.all(TRAIL)).toHaveLength(3);
    expect(view.host.querySelector(FOLD)?.textContent).toBe('Hide the trail');
    await view.click(FOLD);
    expect(view.all(TRAIL)).toHaveLength(0);
    expect(saves).toMatchObject([{ preference: 'history.showTrail', value: false }]);
    expect(saves[0]).not.toHaveProperty('personId');
  });

  it('with nothing stored the trail starts folded, and opening it saves true', async () => {
    const { client, saves } = serving(storing({}));
    const view = await mount(panel(client));
    await tick();
    expect(view.all(TRAIL)).toHaveLength(0);
    await view.click(FOLD);
    expect(view.all(TRAIL)).toHaveLength(3);
    expect(saves).toMatchObject([{ preference: 'history.showTrail', value: true }]);
  });

  it('a click before the store answers stands, and is saved once it does', async () => {
    let answer: ((response: Response) => void) | undefined;
    const late = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { client, saves } = serving(() => late);
    const view = await mount(panel(client));
    await tick();
    await view.click(FOLD);
    expect(view.all(TRAIL)).toHaveLength(3);
    answer?.(json({ ok: true, preferences: { 'history.showTrail': false } }));
    await tick();
    expect(view.all(TRAIL)).toHaveLength(3);
    expect(saves).toMatchObject([{ preference: 'history.showTrail', value: true }]);
  });

  it('a reread of the task keeps the fold as the person left it', async () => {
    const { client } = serving(storing({}));
    const view = await mount(panel(client));
    await tick();
    await view.click(FOLD);
    await view.render(panel(client, 1));
    await tick();
    expect(view.all(TRAIL)).toHaveLength(3);
  });
});
