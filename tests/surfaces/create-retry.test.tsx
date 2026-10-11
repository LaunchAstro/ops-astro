// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Retrying a create whose response was lost, through the new-task draft. The
// Projects quick-add was a second create form; it now opens this one draft
// (U112), so the finding is proved here.
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
import { DraftPanel } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { store } from '../web/draft-support.tsx';
import { mount, settle } from './mount.tsx';

interface AppliedEntry {
  readonly operationId: string;
  readonly title: string;
}

interface Outcome {
  readonly recordId: string;
  readonly revision: number;
  readonly detail: { readonly key: string };
}

/**
 * A server small enough to read, with the one behaviour under test: a create is
 * identified by its `operationId` and a repeat of that identity replays the
 * first outcome instead of writing again.
 */
function server(options: { readonly drop?: boolean } = {}) {
  const tasks: { id: string; key: string; title: string }[] = [];
  const applied: AppliedEntry[] = [];
  const register = new Map<string, Outcome>();
  const creates: Record<string, unknown>[] = [];
  let dropped = options.drop === false;
  // A create the test can hold open. The pending moment is where finding 2's
  // create half lives, and a request that answers inside the flush that
  // started it has no pending moment to inspect.
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;

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
          const made = {
            recordId: `11111111-1111-4111-8111-${String(tasks.length + 1).padStart(12, '0')}`,
            revision: 1,
            detail: { key: `TSK-${String(tasks.length + 1)}` },
          };
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
      const held = gate;
      gate = null;
      await (held ?? Promise.resolve());
      return json(outcome);
    }

    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;

  return {
    fetch,
    tasks,
    applied,
    creates,
    /** The next create stops here until `release` is called. */
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

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function client(fetch: typeof globalThis.fetch): OperationsClient {
  let minted = 0;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => {
      minted += 1;
      return `22222222-2222-4222-8222-${String(minted).padStart(12, '0')}`;
    },
  });
}

const PERSON = 'alpha:mia@alpha.local';

async function openDraft(fetch: typeof globalThis.fetch, storage: Storage) {
  const opened = { created: null as string | null };
  const view = await mount(
    <DraftPanel
      client={client(fetch)}
      storage={storage}
      person={PERSON}
      scope={{ clientId: null, from: 'Projects' }}
      onCreated={(key) => (opened.created = key)}
      onClose={() => {}}
      hold={() => () => true}
    />,
  );
  await settle();
  return { view, opened };
}

describe('a create whose response was lost', () => {
  it('is retried as the same attempt, and one task exists at the end', async () => {
    const api = server();
    const { view, opened } = await openDraft(api.fetch, store());

    await view.type('#panel-draft-name', 'Wire the board to the API');
    await view.click('[data-draft="create"]');
    await settle();

    // What the person sees: an absence, not a refusal, and the name still in
    // the draft. The button now offers the retry rather than a second create.
    expect(view.text()).toContain('Failed to fetch');
    expect(view.find('[data-draft="create"]')?.textContent).toBe('Retry Create');
    expect((view.find('#panel-draft-name') as HTMLInputElement).value).toBe(
      'Wire the board to the API',
    );

    await view.click('[data-draft="create"]');
    await settle();
    await settle();

    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]?.['operationId']).toBe(api.creates[0]?.['operationId']);
    expect(api.tasks).toHaveLength(1);
    expect(api.applied).toHaveLength(1);
    expect(opened.created).toBe('TSK-1');

    await view.unmount();
  });
});

describe('a create whose response was lost', () => {
  it('holds the draft until it is settled, so no edit can make a second task', async () => {
    // Before U112 a changed title started a new attempt beside the lost one,
    // which could leave two tasks. The draft is now read-only until its own
    // retry settles it; Cancel is the deliberate way out.
    const api = server();
    const storage = store();
    const first = await openDraft(api.fetch, storage);
    await first.view.type('#panel-draft-name', 'First task');
    await first.view.click('[data-draft="create"]');
    await settle();
    expect(api.tasks).toHaveLength(1);
    await first.view.unmount();

    // A reload: the same draft and attempt come back, still held.
    const again = await openDraft(api.fetch, storage);
    expect((again.view.find('#panel-draft-name') as HTMLInputElement).readOnly).toBe(true);
    expect(again.view.find('[data-draft-unsettled]')).not.toBeNull();
    await again.view.click('[data-draft="create"]');
    await settle();
    await settle();

    expect(api.creates).toHaveLength(2);
    expect(api.creates[1]?.['operationId']).toBe(api.creates[0]?.['operationId']);
    expect(api.tasks).toHaveLength(1);
    expect(again.opened.created).toBe('TSK-1');

    await again.view.unmount();
  });
});

describe('a create whose response was lost', () => {
  it('is not editable while it is in flight, so a late success erases nothing', async () => {
    // The second half of the review's finding 2. The fields are read-only
    // while the request is out, so nothing typed for the next task is lost
    // when the first one lands.
    const api = server({ drop: false });
    const { view, opened } = await openDraft(api.fetch, store());

    await view.type('#panel-draft-name', 'Wire the board to the API');
    api.hold();
    await view.click('[data-draft="create"]');
    await settle();

    expect(api.creates).toHaveLength(1);
    expect((view.find('#panel-draft-name') as HTMLInputElement).readOnly).toBe(true);
    expect((view.find('[data-draft="create"]') as HTMLButtonElement).disabled).toBe(true);
    expect((view.find('[data-draft="cancel"]') as HTMLButtonElement).disabled).toBe(true);

    api.release();
    await settle();
    await settle();

    expect(api.tasks).toHaveLength(1);
    expect(opened.created).toBe('TSK-1');

    await view.unmount();
  });
});
