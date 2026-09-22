// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The mounted application, driven entirely through a stubbed `fetch`.
//
// This is the test that proves the six read outcomes reach a screen, which is
// the half the unit tests cannot show: `authorised-read.ts` can be correct
// about ordering and `record-state.tsx` correct about rendering while the
// application wires neither to the other.
//
// **It is a stub, and it discharges no browser case.** The acceptance
// checklist's B1-B7 run against the real API and a real database; nothing here
// is evidence for any of them. What it does establish is that a failed read
// never becomes rows on a screen — B7's actual rule — and that the five states
// a person can land on are distinguishable in the mounted app rather than only
// in a component rendered on its own.

import { describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, settle } from './mount.tsx';

/** A storage that is just a map, so the session survives a remount in-test. */
function storage(seed: Record<string, string> = {}): StorageLike {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };

const signedIn = (): SessionStore =>
  new SessionStore(storage({ 'ops-astro.session': JSON.stringify(SESSION) }));

const TASK = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'TSK-1',
  title: 'Wire the board to the API',
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: { personId: 'p1', name: 'Mia Alpha' },
  due: '2026-10-01T00:00:00.000Z',
  priority: null,
  completedAt: null,
  revision: 3,
};

/** A `fetch` that answers from a queue, one scripted reply per call. */
function scripted(replies: readonly (() => Promise<Response>)[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const fetch = (async (url: string | URL) => {
    calls.push(String(url));
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) throw new Error('no scripted reply');
    return reply();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

const never = () =>
  new Promise<Response>(() => {
    /* Held open, so the screen stays on `loading`. */
  });

async function open(fetch: typeof globalThis.fetch, path = '/projects/') {
  return mount(
    <App
      path={path}
      navigate={() => {
        /* The test drives the address directly. */
      }}
      sessions={signedIn()}
      gotrueUrl="http://identity.invalid"
      apiBase="/api"
      fetch={fetch}
    />,
  );
}

describe('the six read outcomes, in the mounted app', () => {
  it('loading: the board says so while the read is in flight', async () => {
    const { fetch } = scripted([never]);
    const view = await open(fetch);
    expect(view.find('[data-outcome="loading"]')).not.toBeNull();
    expect(view.all('.cbd__tbl')).toHaveLength(0);
    await view.unmount();
  });

  it('ready: the rows the API returned, and the task address on each', async () => {
    const { fetch, calls } = scripted([json({ ok: true, tasks: [TASK] })]);
    const view = await open(fetch);
    await settle();
    expect(view.find('[data-outcome="ready"]')).not.toBeNull();
    expect(view.text()).toContain('Wire the board to the API');
    expect(view.find('a.cbd__nm')?.getAttribute('href')).toBe('/task/TSK-1');
    // The board read is the contract's: task.board with an explicit null board.
    expect(calls[0]).toBe('/api/b/alpha/task/board');
    await view.unmount();
  });

  it('no-run: an authorised collection with no rows says it is empty, not denied', async () => {
    const { fetch } = scripted([json({ ok: true, tasks: [] })]);
    const view = await open(fetch);
    await settle();
    expect(view.find('[data-outcome="empty"]')).not.toBeNull();
    expect(view.text()).toContain('You are permitted to see it and it has nothing in it.');
    // Not a success-looking empty table, and not an alert.
    expect(view.all('.cbd__tbl')).toHaveLength(0);
    expect(view.find('[data-outcome="denied"]')).toBeNull();
    await view.unmount();
  });

  it("denied: the server's code reaches the screen, and no rows do", async () => {
    const { fetch } = scripted([
      json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
    ]);
    const view = await open(fetch);
    await settle();
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).toContain('SCOPE_NOT_GRANTED');
    expect(view.text()).not.toContain('Wire the board to the API');
    await view.unmount();
  });

  it('unavailable: a transport failure is not dressed as a denial', async () => {
    const { fetch } = scripted([() => Promise.reject(new Error('connection refused'))]);
    const view = await open(fetch);
    await settle();
    expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(view.text()).toContain('connection refused');
    expect(view.find('[data-outcome="denied"]')).toBeNull();
    await view.unmount();
  });

  it('stale: a value that has stopped being current is dropped, never re-presented', async () => {
    // The sixth outcome is the one the corpus names and these screens never
    // draw: there is no "here are yesterday's rows" state. A read that has
    // gone bad takes its value with it, which is what stops a stale row
    // pretending to be a current one.
    const { fetch } = scripted([
      // The first board read.
      json({ ok: true, tasks: [TASK] }),
      // The create that triggers the reread.
      json({ recordId: '22222222-2222-4222-8222-222222222222', revision: 1 }),
      // And the reread, which does not arrive.
      () => Promise.reject(new Error('the API went away')),
    ]);
    const view = await open(fetch);
    await settle();
    expect(view.text()).toContain('Wire the board to the API');

    // Create a task, which reloads the board. The reload is the read that
    // fails, so the rows on screen are now the previous read's.
    await view.type('#create-title', 'Anything at all');
    await view.click('button[type="submit"]');
    await settle();
    await settle();

    // They are gone. A row that survived here would be a stale row wearing a
    // current one's clothes, which is the substitution B7 forbids.
    expect(view.find('[data-outcome="unavailable"]')).not.toBeNull();
    expect(view.text()).not.toContain('Wire the board to the API');
    await view.unmount();
  });
});

describe('a failed read never becomes sample data', () => {
  // One case per failure, rather than a loop: each mounts its own application
  // and the mounts must not overlap.
  it.each([
    {
      name: 'a refusal',
      reply: json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403),
    },
    { name: 'a server fault', reply: json({ oops: true }, 500) },
    { name: 'a transport failure', reply: () => Promise.reject(new Error('down')) },
  ])('draws no table and no placeholder row after $name', async ({ reply }) => {
    const { fetch } = scripted([reply]);
    const view = await open(fetch);
    await settle();
    expect(view.all('.cbd__tbl')).toHaveLength(0);
    expect(view.all('tr[data-taskrow]')).toHaveLength(0);
    await view.unmount();
  });
});

describe('the address decides the screen', () => {
  it('an unregistered address resolves to nothing rather than to a blank page', async () => {
    const { fetch } = scripted([never]);
    const view = await open(fetch, '/nowhere/');
    expect(view.find('[data-outcome="not-found"]')).not.toBeNull();
    expect(view.text()).toContain('/nowhere/');
    await view.unmount();
  });

  it('signed out, an authenticated address draws sign-in rather than refusing', async () => {
    const { fetch } = scripted([never]);
    const view = await mount(
      <App
        path="/projects/"
        navigate={() => {
          /* unused */
        }}
        sessions={new SessionStore(storage())}
        gotrueUrl="http://identity.invalid"
        apiBase="/api"
        fetch={fetch}
      />,
    );
    expect(view.find('#signin-email')).not.toBeNull();
    await view.unmount();
  });
});
