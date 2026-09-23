// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Retrying a create whose response was lost, through the real form.
//
// The review's first finding is a recovery path, not a race: the server commits
// the task, the response never arrives, the person sees "could not be reached"
// and presses the button again. If the second request carries a fresh
// `operationId` the server has no way to know it is the same intention, so it
// makes a second task and the register it keeps for exactly this purpose never
// gets consulted.
//
// So the assertion is not "the client sent an id". It is that the tiny server
// below — which replays by `operationId`, as the real register does — ends with
// **one** task and **one** applied entry after the person retries. The dropped
// response is modelled the way it happens: the request reaches the server, the
// server commits, and the transport throws on the way back.

import { describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';

interface AppliedEntry {
  readonly operationId: string;
  readonly title: string;
}

interface Outcome {
  readonly recordId: string;
  readonly revision: number;
}

/**
 * A server small enough to read, with the one behaviour under test: a create is
 * identified by its `operationId` and a repeat of that identity replays the
 * first outcome instead of writing again.
 */
function server() {
  const tasks: { id: string; key: string; title: string }[] = [];
  const applied: AppliedEntry[] = [];
  const register = new Map<string, Outcome>();
  const creates: Record<string, unknown>[] = [];
  let dropped = false;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

    if (at.endsWith('/task/create')) {
      creates.push(body);
      const operationId = String(body['operationId']);
      const title = String((body['fields'] as Record<string, unknown>)['title']);
      const replayed = register.get(operationId);
      const outcome =
        replayed ??
        (() => {
          const made = { recordId: `r${String(tasks.length + 1)}`, revision: 1 };
          tasks.push({ id: made.recordId, key: `TSK-${String(tasks.length + 1)}`, title });
          applied.push({ operationId, title });
          register.set(operationId, made);
          return made;
        })();
      if (!dropped) {
        // The commit stands; only the answer is lost. This is the whole case.
        dropped = true;
        throw new TypeError('Failed to fetch');
      }
      return json(outcome);
    }

    if (at.endsWith('/task/board')) {
      return json({
        ok: true,
        tasks: tasks.map((task) => ({
          ...task,
          state: null,
          assignee: null,
          due: null,
          priority: null,
          completedAt: null,
          revision: 1,
        })),
      });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  return { fetch, tasks, applied, creates };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function client(fetch: typeof globalThis.fetch): OperationsClient {
  let minted = 0;
  return new OperationsClient({
    base: '/api',
    businessKey: 'alpha',
    token: 'tok',
    fetch,
    newOperationId: () => {
      minted += 1;
      return `op-${String(minted)}`;
    },
  });
}

const screen = (fetch: typeof globalThis.fetch) => (
  <Projects
    client={client(fetch)}
    grantKey="alpha:mia"
    onOpenTask={() => {
      /* the board's links are not this test's subject */
    }}
  />
);

describe('a create whose response was lost', () => {
  it('is retried as the same attempt, and one task exists at the end', async () => {
    const api = server();
    const view = await mount(screen(api.fetch));
    await settle();

    await view.type('#create-title', 'Wire the board to the API');
    await view.click('button[type="submit"]');
    await settle();

    // What the person sees: an absence, not a refusal, and the title still in
    // the box. The button now offers the retry rather than a second create.
    expect(view.text()).toContain('Failed to fetch');
    expect((view.find('button[type="submit"]') as HTMLElement | null)?.dataset['attempt']).toBe(
      'retry',
    );
    expect((view.find('#create-title') as HTMLInputElement).value).toBe(
      'Wire the board to the API',
    );

    await view.click('button[type="submit"]');
    await settle();
    await settle();

    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]?.['operationId']).toBe(api.creates[0]?.['operationId']);
    expect(api.tasks).toHaveLength(1);
    expect(api.applied).toHaveLength(1);
    expect(view.text()).toContain('Wire the board to the API');
    expect(view.text()).not.toContain('Failed to fetch');

    await view.unmount();
  });

  it('starts a new attempt when the person asks for a different task', async () => {
    const api = server();
    const view = await mount(screen(api.fetch));
    await settle();

    await view.type('#create-title', 'First task');
    await view.click('button[type="submit"]');
    await settle();
    expect(api.tasks).toHaveLength(1);

    // A changed title is a different intention, so it must not be folded into
    // the unresolved attempt: two tasks is the correct answer here.
    await view.type('#create-title', 'A genuinely different task');
    expect((view.find('button[type="submit"]') as HTMLElement | null)?.dataset['attempt']).toBe(
      'new',
    );
    await view.click('button[type="submit"]');
    await settle();
    await settle();

    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]?.['operationId']).not.toBe(api.creates[0]?.['operationId']);
    expect(api.tasks).toHaveLength(2);
    expect(api.applied).toHaveLength(2);

    await view.unmount();
  });
});
