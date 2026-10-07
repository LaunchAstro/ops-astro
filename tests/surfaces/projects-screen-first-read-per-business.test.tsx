// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The board kept drawn through an empty reread is one business's own. A
// switch to another business whose first read answers no tasks says the
// page's empty words, never a board kept from the business before; and a
// return to the first business is a first read again, whatever it drew
// before the switch.

import { afterEach, beforeEach, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';

// A free word in the address survives a board with no rows, so a board kept
// drawn would draw its search, not the page's empty words.
beforeEach(() => {
  window.history.replaceState(null, '', '/projects/?f=&q=launch');
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const task = (id: string) => ({
  id,
  key: id,
  title: `Launch ${id}`,
  state: { id: 's-1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  rank: { number: null, score: null, calc: 'not ranked: missing ease' },
  stage: null,
  clientSet: false,
  statePosition: 1000,
  awaitingDecision: false,
  estimateMinutes: null,
  actualMinutes: 0,
  pageLink: null,
});

/** One business's API: its board reads answer in turn, the last one again after. */
function business(key: string, answers: readonly (readonly ReturnType<typeof task>[])[]) {
  let reads = 0;
  const fetch = ((url: string) => {
    const at = String(url);
    if (/\/live(\?|$)/u.test(at)) {
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>(), { status: 200 }));
    }
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: 0 }));
    if (at.endsWith('/task/board')) {
      const tasks = answers[Math.min(reads, answers.length - 1)] ?? [];
      reads += 1;
      return Promise.resolve(json({ ok: true, tasks, changedAt: null, viewer: null, withheld: 0 }));
    }
    if (at.endsWith('person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    return Promise.resolve(json({ ok: true, clients: [] }));
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey: key, signedIn: true, fetch });
}

const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- each pass flushes the next hop
    await settle();
  }
};

const EMPTY = 'No tasks on this board yet.';

const at = (client: OperationsClient, grantKey: string) => (
  <Projects client={client} grantKey={grantKey} navigate={() => {}} />
);

it('a switch to a business whose first read is empty says the empty words, and so does a return', async () => {
  const alpha = business('alpha', [[task('alpha-1')], []]);
  const beta = business('beta', [[]]);
  const view = await mount(at(alpha, 'alpha:mia'));
  await settleAll();
  expect(view.find('tr[data-row="alpha-1"]')).not.toBeNull();

  await view.render(at(beta, 'beta:mia'));
  await settleAll();
  expect(view.find('tr[data-row]'), 'another business’s row is drawn').toBeNull();
  expect(view.find('[data-board]'), 'a board kept from the business before').toBeNull();
  expect(view.text()).toContain(EMPTY);

  await view.render(at(alpha, 'alpha:mia'));
  await settleAll();
  expect(view.find('[data-board]'), 'a return was read as a kept reread').toBeNull();
  expect(view.text()).toContain(EMPTY);
});
