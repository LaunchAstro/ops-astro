// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-13's new-task draft in the dock task panel (CS-4.36, CS-4.37; DN-01,
// DN-03 to DN-05; DP-02): the head's New task opens a draft, the draft is
// kept for its person until Create or Cancel, and Create writes a real task
// and then everything added on the draft through each one's own command, so
// each is audited under its own name. Closing the panel, or opening another
// task in it, while this person's timer runs stops and logs it (TR-S-PI6-4).
//
// The commands themselves (their rules, refusals, audit and isolation) are
// the server suites for `task.create`, `task.set_party`, the tag commands,
// `time.log` and `task.comment`; these prove what the draft sends.

import { act, useEffect, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { DraftPanel, type DraftScope } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { useTaskPanel } from '../../apps/web/src/screens/task/panel-host.ts';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { json, mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const NEW_ID = '7c1e5a52-0b43-4c1f-9d1a-1b2c3d4e5f60';
const NEW_KEY = 'Proj-New-Brief';
const ADA = 'alpha:ada@example.test';

interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A server that answers a create with a new task, and refuses the paths in `refuse`. */
function server(refuse: readonly string[] = [], unknownCreates = 0) {
  const sent: Sent[] = [];
  let unknown = unknownCreates;
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const to = String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to, body });
    if (to === '/tag/list') {
      return Promise.resolve(json({ ok: true, tags: [{ id: 'g-legal', name: 'Legal' }] }));
    }
    if (refuse.includes(to)) {
      return Promise.resolve(
        json({ ok: false, code: 'NOT_FOUND', message: 'No such thing.' }, 404),
      );
    }
    if (to === '/task/create' && body['parentId'] === undefined) {
      if (unknown > 0) {
        unknown -= 1;
        return Promise.reject(new TypeError('network down'));
      }
      return Promise.resolve(json({ recordId: NEW_ID, revision: 1, detail: { key: NEW_KEY } }));
    }
    const detail = to === '/tag/create' ? { tagId: 'g-new', name: body['name'] } : {};
    return Promise.resolve(json({ recordId: NEW_ID, revision: 2, detail }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch }),
    sent,
  };
}

/** A browser store of its own for each test. */
function store(): Storage {
  const held = new Map<string, string>();
  return {
    get length() {
      return held.size;
    },
    clear: () => held.clear(),
    getItem: (key) => held.get(key) ?? null,
    key: (index) => [...held.keys()][index] ?? null,
    removeItem: (key) => held.delete(key),
    setItem: (key, value) => held.set(key, value),
  };
}

const NO_CLIENT: DraftScope = { clientId: null, from: 'Budget pacing fix' };

async function draft(
  over: {
    readonly client?: OperationsClient;
    readonly storage?: Storage;
    readonly person?: string;
    readonly scope?: DraftScope;
  } = {},
) {
  const outcome = { created: null as string | null, closed: 0 };
  const view = await mount(
    <DraftPanel
      client={over.client ?? server().client}
      storage={over.storage ?? store()}
      person={over.person ?? ADA}
      scope={over.scope ?? NO_CLIENT}
      onCreated={(key) => (outcome.created = key)}
      onClose={() => (outcome.closed += 1)}
    />,
  );
  await tick();
  return { view, outcome };
}

type View = Awaited<ReturnType<typeof draft>>['view'];

const fill = async (view: View): Promise<void> => {
  await typeInto(view, '#panel-draft-name', 'New brief');
  await view.type('#panel-draft-due', '2026-10-09');
  await view.choose('#panel-draft-estimate', '60');
  for (const tag of ['legal', 'Launch']) {
    // eslint-disable-next-line no-await-in-loop -- one keystroke at a time
    await typeInto(view, '#panel-draft-tags', tag);
    // eslint-disable-next-line no-await-in-loop -- one keystroke at a time
    await press(view, '#panel-draft-tags', 'Enter');
  }
  await typeInto(view, '#panel-draft-steps', 'Call the client');
  await press(view, '#panel-draft-steps', 'Enter');
  await typeInto(view, '#panel-draft-time', '30m');
  await typeInto(view, '#panel-draft-note', 'From the kickoff call.');
};

const valueOf = (view: View, selector: string): string =>
  (view.find(selector) as HTMLInputElement | null)?.value ?? '';

const create = async (view: View): Promise<void> => {
  await view.click('[data-draft="create"]');
  for (let settle = 0; settle < 12; settle += 1) {
    // eslint-disable-next-line no-await-in-loop -- the chain is one request at a time
    await tick();
  }
};

describe('MP-4-13 the head’s New task opens a draft', () => {
  it('the dock task panel’s New task is a live door that asks the host for a draft', async () => {
    const asked = { count: 0 };
    const view = await mount(
      <PanelWithDoor
        onNewTask={() => {
          asked.count += 1;
        }}
      />,
    );
    await tick();
    const door = view.find('[data-panel-head="new"]') as HTMLButtonElement;
    expect(door.disabled).toBe(false);
    await view.click('[data-panel-head="new"]');
    expect(asked.count).toBe(1);
  });

  it('the draft says where it was filed from, and nothing is stored until Create', async () => {
    const { view } = await draft();
    expect(view.find('[data-draft-admission]')?.textContent).toBe(
      'New task, filed from Budget pacing fix. Nothing is stored until Create.',
    );
    expect(document.activeElement?.id).toBe('panel-draft-name');
  });
});

describe('MP-4-13 CS-4.36 name the new task', () => {
  it('an empty name is refused with the field focused, and nothing is sent', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', '   ');
    (view.find('[data-draft="create"]') as HTMLElement).focus();
    await create(view);
    expect(sent).toStrictEqual([]);
    expect(document.activeElement?.id).toBe('panel-draft-name');
    expect(view.find('[data-draft-refusal]')?.textContent).toBe('Name the new task first.');
  });

  it('not audited: typing on the draft sends nothing', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await fill(view);
    expect(sent).toStrictEqual([]);
  });
});

describe('MP-4-13 draft kept until create or cancel', () => {
  it('X, Escape and a reload keep the draft as left; reopening New task brings it back', async () => {
    const storage = store();
    const first = await draft({ storage });
    await fill(first.view);
    await press(first.view, '[data-draft-panel]', 'Escape');
    expect(first.outcome.closed).toBe(1);
    await first.view.click('[data-draft="close"]');
    expect(first.outcome.closed).toBe(2);
    await first.view.unmount();
    const again = await draft({ storage });
    expect(valueOf(again.view, '#panel-draft-name')).toBe('New brief');
    expect(valueOf(again.view, '#panel-draft-due')).toBe('2026-10-09');
    expect(valueOf(again.view, '#panel-draft-estimate')).toBe('60');
    expect(
      again.view.all('[data-draft-tag]').map((chip) => chip.getAttribute('data-draft-tag')),
    ).toStrictEqual(['legal', 'Launch']);
    expect(again.view.all('[data-draft-step]').map((row) => row.textContent)).toStrictEqual([
      'Call the client',
    ]);
    expect(valueOf(again.view, '#panel-draft-time')).toBe('30m');
    expect(valueOf(again.view, '#panel-draft-note')).toBe('From the kickoff call.');
  });

  it('Cancel discards the draft on purpose', async () => {
    const storage = store();
    const first = await draft({ storage });
    await fill(first.view);
    await first.view.click('[data-draft="cancel"]');
    expect(first.outcome.closed).toBe(1);
    expect(storage.length).toBe(0);
    await first.view.unmount();
    const again = await draft({ storage });
    expect(valueOf(again.view, '#panel-draft-name')).toBe('');
  });

  it('MP-4-13 isolation: a draft is its own person’s, in its own business', async () => {
    const storage = store();
    const ada = await draft({ storage });
    await typeInto(ada.view, '#panel-draft-name', 'Ada’s canary');
    await ada.view.unmount();
    for (const person of ['alpha:grace@example.test', 'bravo:ada@example.test']) {
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const other = await draft({ storage, person });
      expect(valueOf(other.view, '#panel-draft-name')).toBe('');
      expect(other.view.text()).not.toContain('canary');
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      await other.view.unmount();
    }
  });
});

describe('MP-4-13 CS-4.37 Create writes a real task', () => {
  it('the task first, then every field and part chosen on the draft, each by its own command', async () => {
    const { client, sent } = server();
    const storage = store();
    const { view, outcome } = await draft({
      client,
      storage,
      scope: { clientId: 'c-client-a', from: 'Client A' },
    });
    await fill(view);
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual([
      '/task/create',
      '/task/set_party',
      '/task/comment',
      '/tag/list',
      '/task/add_tag',
      '/tag/create',
      '/task/add_tag',
      '/task/create',
      '/time/log',
    ]);
    expect(sent[0]?.body).toMatchObject({
      fields: { title: 'New brief', due: '2026-10-09', estimated_minutes: 60 },
      board: null,
    });
    expect(sent[1]?.body).toMatchObject({
      recordId: NEW_ID,
      fields: { client: 'c-client-a' },
      expectedRevision: 1,
    });
    expect(sent[2]?.body).toMatchObject({
      recordId: NEW_ID,
      body: 'From the kickoff call.',
      audience: 'internal',
      commentType: 'note',
      expectedRevision: 2,
    });
    expect(sent[4]?.body).toMatchObject({ recordId: NEW_ID, tagId: 'g-legal' });
    expect(sent[5]?.body).toMatchObject({ name: 'Launch' });
    expect(sent[6]?.body).toMatchObject({ recordId: NEW_ID, tagId: 'g-new' });
    expect(sent[7]?.body).toMatchObject({ fields: { title: 'Call the client' }, parentId: NEW_ID });
    expect(sent[8]?.body).toMatchObject({ taskId: NEW_ID, duration: '30m' });
    expect(outcome.created).toBe(NEW_KEY);
    expect(storage.length).toBe(0);
  });

  it('the client comes from the page’s scope, or is left empty: never a fixed client', async () => {
    const { client, sent } = server();
    const { view } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'No client here');
    await create(view);
    expect(sent.map((one) => one.to)).toStrictEqual(['/task/create']);
    expect(sent[0]?.body['fields']).toStrictEqual({ title: 'No client here' });
  });

  it('Create works whether or not any task list has been opened first', async () => {
    const { client, sent } = server();
    const { view, outcome } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'First thing today');
    await create(view);
    expect(sent.some((one) => one.to === '/task/board')).toBe(false);
    expect(outcome.created).toBe(NEW_KEY);
  });

  it('a part refused after the task exists is named, and the task is not created twice', async () => {
    const { client, sent } = server(['/task/add_tag']);
    const storage = store();
    const { view, outcome } = await draft({ client, storage });
    await typeInto(view, '#panel-draft-name', 'New brief');
    await typeInto(view, '#panel-draft-tags', 'Legal');
    await press(view, '#panel-draft-tags', 'Enter');
    await create(view);
    expect(view.find('[data-draft-missed]')?.textContent).toContain('the tag Legal');
    expect(outcome.created).toBeNull();
    expect(storage.length).toBe(0);
    await view.click('[data-draft="open-created"]');
    expect(outcome.created).toBe(NEW_KEY);
    expect(sent.filter((one) => one.to === '/task/create')).toHaveLength(1);
  });

  it('an unknown outcome keeps the create’s identity, so the retry cannot make a second task', async () => {
    const { client, sent } = server([], 1);
    const { view, outcome } = await draft({ client });
    await typeInto(view, '#panel-draft-name', 'New brief');
    await create(view);
    expect(outcome.created).toBeNull();
    await create(view);
    const creates = sent.filter((one) => one.to === '/task/create');
    expect(creates).toHaveLength(2);
    expect(creates[1]?.body['operationId']).toBe(creates[0]?.body['operationId']);
    expect(outcome.created).toBe(NEW_KEY);
  });
});

describe('MP-4-13 close stops the running timer', () => {
  const RUNNING = {
    time: {
      entries: [],
      running: { entryId: 'e-1', startedAt: '2026-09-30T08:00:00Z' },
      totalMinutes: 0,
    },
  };

  it('the panel hands its host a stop while this person’s timer runs on its task', async () => {
    const { client, sent } = serving(RUNNING);
    const leaving: { stop: (() => void) | null } = { stop: null };
    await panel(client, {
      leaving: (stop) => {
        leaving.stop = stop;
      },
    });
    expect(leaving.stop).not.toBeNull();
    await act(async () => {
      leaving.stop?.();
      await Promise.resolve();
    });
    expect(sent.map((one) => [one.to, one.body['taskId']])).toStrictEqual([
      ['/time/stop', TASK_ID],
    ]);
  });

  it('no timer running on the task: nothing to stop', async () => {
    const { client } = serving();
    const leaving: { stop: (() => void) | null } = { stop: () => undefined };
    await panel(client, {
      leaving: (stop) => {
        leaving.stop = stop;
      },
    });
    expect(leaving.stop).toBeNull();
  });

  it('the host runs the stop on X, on opening another task and on a new draft, never twice', async () => {
    const stops: string[] = [];
    const view = await mount(<Host onStop={(why) => stops.push(why)} />);
    await tick();
    for (const [button, why] of [
      ['close', 'close'],
      ['other', 'other'],
      ['draft', 'draft'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one gesture at a time
      await view.click(`[data-host="arm-${why}"]`);
      // eslint-disable-next-line no-await-in-loop -- one gesture at a time
      await view.click(`[data-host="${button}"]`);
    }
    await view.click('[data-host="close"]');
    expect(stops).toStrictEqual(['close', 'other', 'draft']);
  });
});

/** The panel with its head, for the door: the task stub answers its read. */
function PanelWithDoor(props: { readonly onNewTask: () => void }): ReactElement {
  const { client } = serving();
  return (
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={{ taskKey: 'Proj-Verity-Pacing', door: 'open', tab: null }}
      onChanged={() => undefined}
      onClose={() => undefined}
      onNewTask={props.onNewTask}
    />
  );
}

/** The host with buttons for each gesture, and a stop armed before each. */
function Host(props: { readonly onStop: (why: string) => void }): ReactElement {
  const host = useTaskPanel();
  useEffect(() => {
    host.host.open('Proj-Verity-Pacing', 'open');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);
  const arm = (why: string) => () => {
    host.leaving(() => props.onStop(why));
  };
  return (
    <div>
      {['close', 'other', 'draft'].map((why) => (
        <button key={why} type="button" data-host={`arm-${why}`} onClick={arm(why)}>
          arm
        </button>
      ))}
      <button type="button" data-host="close" onClick={host.close}>
        close
      </button>
      <button
        type="button"
        data-host="other"
        onClick={() => {
          host.host.open('Proj-Other', 'open');
        }}
      >
        other
      </button>
      <button
        type="button"
        data-host="draft"
        onClick={() => {
          host.openDraft(NO_CLIENT);
        }}
      >
        draft
      </button>
    </div>
  );
}
