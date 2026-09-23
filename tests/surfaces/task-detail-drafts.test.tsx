// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Unsaved title and due-date edits on the real task screen, and the rule that
// replaced two rounds of draft merging: **an unsaved edit is resolved, not
// merged.**
//
// The review's two holding findings were both merge failures. Finding 1: a
// refresh handed the draft a revision it had never been checked against, so a
// save could erase a second writer's field with no conflict anywhere. Finding
// 2: a save that settled after further typing cleared the newer draft, so the
// newer text vanished. Extending the merge was the thing that kept producing
// these, so the screen stopped: while an edit is unsaved, assignment, the
// lifecycle buttons and Refresh are disabled and the person answers Save or
// Discard.
//
// These cases drive the real `TaskDetailScreen` over a stubbed transport that
// keeps a revision and refuses a stale one the way the server does. They hold
// the other half in place too: an edit must **not** outlive its task, its grant
// or an authorised-read denial, since stale authorised text left on screen is
// the failure the whole read module exists to prevent.

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
  // The same device for a write. A save that answers inside the flush that
  // started it is a save with no in-flight moment, and the in-flight moment is
  // the whole of finding 2.
  let mutationGate: Promise<void> | null = null;
  let openMutation: (() => void) | null = null;
  const updates: Record<string, unknown>[] = [];

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

    if (at.endsWith('/task/update')) {
      updates.push(body);
      // The server's stale-edit protection, in the two lines that matter: the
      // revision the caller made the edit against is compared with the one the
      // record actually holds, and a caller that is behind is refused rather
      // than applied. Without this the test could not tell a fix from a
      // silent overwrite.
      const expected = Number(body['expectedRevision']);
      const held = mutationGate;
      mutationGate = null;
      await (held ?? Promise.resolve());
      if (expected !== task.revision) {
        return json(
          {
            refused: true,
            code: 'VERSION_STALE',
            names: [`revision=${String(task.revision)}`],
            fixes: ['Read the task again and make the change on top of the current one.'],
          },
          409,
        );
      }
      const fields = body['fields'] as Record<string, unknown>;
      task.title = String(fields['title']);
      task.due = fields['due'] === null ? null : String(fields['due']);
      task.revision += 1;
      return json({ recordId: task.id, revision: task.revision });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    task,
    reads,
    updates,
    /** Somebody else saves a due date. The record moves on; this screen is behind. */
    secondWriterSetsDue: (iso: string) => {
      task.due = iso;
      task.revision += 1;
    },
    /** The next mutation stops here until `releaseMutation` is called. */
    holdMutation: () => {
      mutationGate = new Promise<void>((resolve) => {
        openMutation = resolve;
      });
    },
    releaseMutation: () => {
      openMutation?.();
    },
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

/** Every `invalid` event the title reports, which is the form saying why. */
const watchInvalid = (host: HTMLElement): { readonly count: () => number } => {
  let seen = 0;
  host.querySelector('#task-title')?.addEventListener('invalid', () => {
    seen += 1;
  });
  return { count: () => seen };
};

const disabledOf = (host: HTMLElement, selector: string): boolean => {
  const found = host.querySelector(selector) as HTMLInputElement | null;
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found.disabled;
};

describe('an unsaved edit is resolved, not merged', () => {
  it('is offered at the revision it began from, so a second writer is not erased', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();
    expect(view.text()).toContain('Revision 3');

    // The person starts editing the title against revision 3.
    await view.type('#task-title', 'A title nobody has saved yet');

    // Somebody else saves a due date. The record is now at revision 4 and this
    // screen has never seen it. This is the review's finding-1 example.
    api.secondWriterSetsDue('2026-12-24');

    // Refresh is the control that used to attach the newer revision to the
    // older edit. It is not available while the edit is unsaved.
    expect(disabledOf(view.host, 'button[data-refresh="task"]')).toBe(true);

    await view.click('button[data-draft-resolve="save"]');
    await tick();

    // The save went out against revision 3, not 4, so the server refused it.
    expect(api.updates[0]?.['expectedRevision']).toBe(3);
    expect(view.find('[data-conflict="version"]')).not.toBeNull();
    expect(view.text()).toContain('VERSION_STALE');

    // The other writer's due date is still there and the title is still theirs:
    // nothing was overwritten, silently or otherwise.
    expect(api.task.due).toBe('2026-12-24');
    expect(api.task.title).toBe(TASK.title);
    expect(api.task.revision).toBe(4);

    // Resolving reads the task again and starts from what the server holds.
    await view.click('button[data-conflict="reload"]');
    await tick();
    expect(valueOf(view.host, '#task-due')).toBe('2026-12-24');
    expect(valueOf(view.host, '#task-title')).toBe(TASK.title);
    expect(view.find('[data-draft-resolve="choice"]')).toBeNull();

    await view.unmount();
  });

  it('holds the assignee, the lifecycle and Refresh until Save or Discard is answered', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    // Clean: everything is available.
    expect(disabledOf(view.host, 'button[data-refresh="task"]')).toBe(false);
    expect(disabledOf(view.host, 'select[aria-label="Assignee"]')).toBe(false);
    expect(disabledOf(view.host, 'button[data-lifecycle="start"]')).toBe(false);
    expect(view.find('[data-draft-resolve="choice"]')).toBeNull();

    await view.type('#task-due', '2026-11-30');

    // Dirty: the choice is on the screen and the silent paths are shut. Each of
    // these controls used to reload the task underneath the unsaved edit.
    expect(view.find('[data-draft-resolve="choice"]')).not.toBeNull();
    expect(disabledOf(view.host, 'button[data-refresh="task"]')).toBe(true);
    expect(disabledOf(view.host, 'select[aria-label="Assignee"]')).toBe(true);
    expect(disabledOf(view.host, 'button[data-lifecycle="start"]')).toBe(true);
    expect(disabledOf(view.host, 'button[data-lifecycle="complete"]')).toBe(true);
    expect(disabledOf(view.host, 'button[data-lifecycle="reopen"]')).toBe(true);
    expect(api.reads).toHaveLength(1);

    await view.unmount();
  });

  it('is discarded on request, and the saved values come back', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'A title nobody has saved yet');
    await view.click('button[data-draft-resolve="discard"]');
    await tick();

    expect(valueOf(view.host, '#task-title')).toBe(TASK.title);
    expect(view.find('[data-draft-resolve="choice"]')).toBeNull();
    expect(api.updates).toHaveLength(0);

    // Released: the assignment the edit was blocking now goes through.
    expect(disabledOf(view.host, 'select[aria-label="Assignee"]')).toBe(false);
    await choose(view.host, 'select[aria-label="Assignee"]', 'p2');
    await tick();
    expect(api.task.assignee?.personId).toBe('p2');

    await view.unmount();
  });

  it('is saved on request, and the saved values are what the screen then shows', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'A title somebody did save');
    await view.type('#task-due', '2026-11-30');
    await view.click('button[data-draft-resolve="save"]');
    await tick();

    expect(api.task.title).toBe('A title somebody did save');
    expect(api.task.due).toBe('2026-11-30');
    expect(view.find('[data-draft-resolve="choice"]')).toBeNull();
    expect(view.find('[data-conflict="version"]')).toBeNull();
    expect(valueOf(view.host, '#task-title')).toBe('A title somebody did save');
    expect(disabledOf(view.host, 'button[data-refresh="task"]')).toBe(false);

    await view.unmount();
  });

  it('cannot be edited while the save it belongs to is in flight', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'The text that was submitted');

    // Hold the save open, so the in-flight moment is a fact rather than a race.
    // This is the moment finding 2 lives in: typing here used to be possible
    // and the arriving response used to delete it.
    api.holdMutation();
    await view.click('.taskform button[type="submit"]');
    await until('the save reached the wire', () => api.updates.length === 1, Date.now() + 5000);

    expect(disabledOf(view.host, '#task-title')).toBe(true);
    expect(disabledOf(view.host, '#task-due')).toBe(true);
    expect(disabledOf(view.host, '.taskform button[type="submit"]')).toBe(true);
    expect(disabledOf(view.host, 'button[data-draft-resolve="save"]')).toBe(true);
    expect(disabledOf(view.host, 'button[data-draft-resolve="discard"]')).toBe(true);

    api.releaseMutation();
    await tick();

    // One save, one applied edit, and the settled screen shows it.
    expect(api.updates).toHaveLength(1);
    expect(api.task.title).toBe('The text that was submitted');
    expect(valueOf(view.host, '#task-title')).toBe('The text that was submitted');
    expect(view.find('[data-draft-resolve="choice"]')).toBeNull();

    await view.unmount();
  });

  it('is dropped when the task changes, so one task never shows another one edit', async () => {
    const api = server();
    const held = client(api.fetch);
    const view = await mount(
      <TaskDetailScreen client={held} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', 'A title nobody has saved yet');
    await view.render(<TaskDetailScreen client={held} grantKey="alpha:mia" taskKey="TSK-2" />);
    await tick();

    expect(valueOf(view.host, '#task-title')).toBe(TASK.title);
    expect(view.find('[data-draft-resolve="choice"]')).toBeNull();

    await view.unmount();
  });

  it('is dropped when the grant changes, so no stale authorised text remains', async () => {
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

  it('is dropped when the read is denied', async () => {
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

/**
 * Review finding 1. The resolve bar's Save was `type="button"` outside the
 * details form and called the save directly, so it skipped the `required` on
 * Title that the form's own submit had always enforced. A cleared title went out
 * as `title: ''`, the core's text check accepted it, and the board drew the task
 * as a blank link. Both controls now submit the one form, so the check is the
 * same check whichever one is pressed.
 */
describe("a cleared title is refused by both Save controls, not just the form's", () => {
  for (const control of [
    { what: 'the resolve bar', selector: 'button[data-draft-resolve="save"]' },
    { what: "the form's own submit", selector: 'form#task-fields button[type="submit"]' },
  ]) {
    it(`sends nothing and reports why, from ${control.what}`, async () => {
      const api = server();
      const view = await mount(
        <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
      );
      await tick();

      await view.type('#task-title', '');
      // The edit is unsaved, so the bar is on the screen and both controls exist.
      expect(view.find('[data-draft-resolve="choice"]')).not.toBeNull();
      const invalid = watchInvalid(view.host);

      await view.click(control.selector);
      await tick();

      // Nothing left the screen, so nothing can have reached the board.
      expect(api.updates).toHaveLength(0);
      expect(api.task.title).toBe(TASK.title);
      expect(api.task.revision).toBe(TASK.revision);
      // The form said which field is wrong rather than failing silently.
      expect(invalid.count()).toBeGreaterThan(0);
      expect((view.find('#task-title') as HTMLInputElement).validity.valueMissing).toBe(true);
      expect((view.find('form#task-fields') as HTMLFormElement).checkValidity()).toBe(false);
      // The edit is still the person's to fix: it was refused, not discarded.
      expect(valueOf(view.host, '#task-title')).toBe('');
      expect(view.find('[data-draft-resolve="choice"]')).not.toBeNull();

      await view.unmount();
    });
  }

  it('lets the edit through once a title is put back', async () => {
    const api = server();
    const view = await mount(
      <TaskDetailScreen client={client(api.fetch)} grantKey="alpha:mia" taskKey={TASK.id} />,
    );
    await tick();

    await view.type('#task-title', '');
    await view.click('button[data-draft-resolve="save"]');
    await tick();
    expect(api.updates).toHaveLength(0);

    await view.type('#task-title', 'A title somebody put back');
    expect((view.find('form#task-fields') as HTMLFormElement).checkValidity()).toBe(true);
    await view.click('button[data-draft-resolve="save"]');
    await tick();

    expect(api.updates).toHaveLength(1);
    expect(api.task.title).toBe('A title somebody put back');
    expect(api.task.revision).toBe(TASK.revision + 1);
    expect(view.find('[data-draft-resolve="choice"]')).toBeNull();

    await view.unmount();
  });
});
