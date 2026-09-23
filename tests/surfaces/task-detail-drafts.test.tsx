// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Unsaved title and due-date drafts across an assignment, through the real
// screen.
//
// The review's second finding is a lifetime one: the drafts used to live in
// the component `RecordState` unmounts while the refreshing read is in flight,
// so a successful assign or lifecycle action silently threw away whatever the
// person had typed. Nothing on the screen said so and nothing asked.
//
// This drives the real `TaskDetailScreen` over a stubbed transport with a real
// read round trip in between, because the bug only appears once the read
// actually goes away and comes back. It also holds the other half of the
// finding in place: a draft must **not** outlive its task, its grant or an
// authorised-read denial, since stale authorised data left on screen is the
// failure the whole read module exists to prevent.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'TSK-1',
  title: 'Wire the board to the API',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null as { personId: string; name: string } | null,
  due: null as string | null,
  priority: null,
  completedAt: null,
  revision: 3,
  history: [] as { at: string; actorId: string; operation: string }[],
};

const PEOPLE = [
  { personId: 'p1', name: 'Mia Alpha' },
  { personId: 'p2', name: 'Noah Alpha' },
];

/** One macrotask, so a read is a round trip rather than an immediate answer. */
const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/** Let the deferred reads land, React included. */
const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

/**
 * Flush until the page says something, or give up loudly.
 *
 * Bounded, and recursive rather than a loop because the repository's lint
 * forbids awaiting in one.
 */
async function until(say: string, check: () => boolean, deadline: number): Promise<void> {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await act(async () => {
    await pause();
  });
  return until(say, check, deadline);
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** One task, an assign that really changes it, and a read that really reloads. */
function server(options: { readonly denyReads?: boolean } = {}) {
  const task = { ...TASK };
  const reads: string[] = [];
  let denied = options.denyReads ?? false;
  // A read the test can hold open. Waiting a fixed moment for the refreshing
  // `loading` state to appear is a race, and a race in the test is the thing
  // this file exists to argue against; holding the read makes the moment the
  // assertions want a fact rather than a hope.
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;

  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

    if (at.endsWith('/person/list')) return json({ ok: true, persons: PEOPLE });

    if (at.endsWith('/task/read')) {
      reads.push(String(body['recordId']));
      // A real read crosses a network, so it does not resolve inside the flush
      // that started it. Without this the refreshing `loading` state never
      // reaches the DOM, `Loaded` is never unmounted, and the test would pass
      // against the very code the finding is about.
      const held = gate;
      gate = null;
      await (held ?? pause());
      if (denied) {
        return json(
          {
            refused: true,
            code: 'SCOPE_NOT_GRANTED',
            names: ['tasks'],
            fixes: ['Ask an administrator for the task collection scope.'],
          },
          403,
        );
      }
      return json({ ok: true, task });
    }

    if (at.endsWith('/task/assign')) {
      const fields = body['fields'] as Record<string, unknown>;
      const chosen = PEOPLE.find((person) => person.personId === fields['assignee']) ?? null;
      task.assignee = chosen;
      task.revision += 1;
      return json({ recordId: task.id, revision: task.revision });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    task,
    reads,
    deny: () => {
      denied = true;
    },
    allow: () => {
      denied = false;
    },
    /** The next read stops here until `release` is called. */
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      open?.();
    },
  };
}

const client = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({
    base: '/api',
    businessKey: 'alpha',
    token: 'tok',
    fetch,
    newOperationId: () => 'op-1',
  });

/** A select the way a person changes one: React's own setter, then `change`. */
async function choose(host: HTMLElement, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector) as HTMLSelectElement | null;
  if (field === null) throw new Error(`nothing matches ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const valueOf = (host: HTMLElement, selector: string): string =>
  (host.querySelector(selector) as HTMLInputElement).value;

describe('unsaved details across an assignment', () => {
  it('survive a successful assign and the refreshed read that follows it', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'A title nobody has saved yet');
    await view.type('#task-due', '2026-11-30');
    expect(valueOf(view.host, '#task-title')).toBe('A title nobody has saved yet');

    // Hold the refreshing read open, so the state between the successful
    // assign and the arriving data can be observed rather than raced for.
    api.hold();
    await choose(view.host, 'select[aria-label="Assignee"]', 'p2');
    await until(
      'the refreshing read reached the screen',
      () => view.find('[data-outcome="loading"]') !== null,
      Date.now() + 5000,
    );

    // The refresh is on the screen and the form is not: this is the moment the
    // drafts used to die, and asserting it here is what stops this test
    // passing for the wrong reason.
    expect(view.find('#task-title')).toBeNull();

    api.release();
    await tick();

    // The assign really happened and the read really went round again, so the
    // form on screen is a fresh mount, not the one that was typed into.
    expect(api.task.assignee?.personId).toBe('p2');
    expect(api.reads.length).toBeGreaterThan(1);
    expect(view.text()).toContain('Revision 4');

    expect(valueOf(view.host, '#task-title')).toBe('A title nobody has saved yet');
    expect(valueOf(view.host, '#task-due')).toBe('2026-11-30');

    await view.unmount();
  });

  it('survive the Refresh button, which is an authorised reread of the same task', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'A title nobody has saved yet');
    await view.type('#task-due', '2026-11-30');

    // Refresh is the other way a read of this task starts over, and it is the
    // one a person presses *because* they suspect the screen is behind. Doing
    // that with unsaved text in the inputs must not be how they lose it. The
    // read is held open so the intermediate state is observed rather than
    // raced for, exactly as in the assignment case.
    const before = api.reads.length;
    api.hold();
    await view.click('button[data-refresh="task"]');
    await until(
      'the refresh reached the screen',
      () => view.find('[data-outcome="loading"]') !== null,
      Date.now() + 5000,
    );
    expect(view.find('#task-title')).toBeNull();

    api.release();
    await tick();

    expect(api.reads.length).toBeGreaterThan(before);
    expect(valueOf(view.host, '#task-title')).toBe('A title nobody has saved yet');
    expect(valueOf(view.host, '#task-due')).toBe('2026-11-30');

    await view.unmount();
  });

  it('are dropped when the grant changes, so no stale authorised text remains', async () => {
    const api = server();
    const held = client(api.fetch);
    const view = await mount(
      <TaskDetailScreen client={held} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'A title nobody has saved yet');
    await view.render(<TaskDetailScreen client={held} grantKey="alpha:bea" taskKey={TASK.id} />);
    await tick();

    expect(valueOf(view.host, '#task-title')).toBe(TASK.title);

    await view.unmount();
  });

  it('are dropped when the read is denied', async () => {
    const api = server();
    const held = client(api.fetch);
    const view = await mount(
      <TaskDetailScreen client={held} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'A title nobody has saved yet');
    api.deny();
    await view.render(<TaskDetailScreen client={held} grantKey="alpha:noah" taskKey={TASK.id} />);
    await tick();

    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(view.text()).not.toContain('A title nobody has saved yet');

    // Back under a grant that is allowed: the saved title, not the abandoned draft.
    api.allow();
    await view.render(<TaskDetailScreen client={held} grantKey="alpha:mia" taskKey={TASK.id} />);
    await tick();
    expect(valueOf(view.host, '#task-title')).toBe(TASK.title);

    await view.unmount();
  });
});
