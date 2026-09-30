// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the MP-4-13 suites: a server that answers a create with a new
// task, a browser store of its own per test, the draft mounted, and the host
// with a button per gesture.
//
// A harness, not a suite: nothing here runs on its own.

import { useEffect, type ReactElement } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { DraftPanel, type DraftScope } from '../../apps/web/src/screens/task/DraftPanel.tsx';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { useTaskPanel } from '../../apps/web/src/screens/task/panel-host.ts';
import { tick } from './task-page-stub.tsx';
import { json, mount, press, typeInto } from './perspective-support.tsx';
import { serving } from './panel-fields-support.tsx';

export const NEW_ID = '7c1e5a52-0b43-4c1f-9d1a-1b2c3d4e5f60';
export const NEW_KEY = 'Proj-New-Brief';
export const ADA = 'alpha:ada@example.test';

export interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A server that answers a create with a new task, and refuses the paths in `refuse`. */
export function server(refuse: readonly string[] = [], unknownCreates = 0) {
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
        json({ refused: true, code: 'NOT_FOUND', names: ['tagId'], fixes: [] }, 404),
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
export function store(): Storage {
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

export const NO_CLIENT: DraftScope = { clientId: null, from: 'Budget pacing fix' };

export async function draft(
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

export type View = Awaited<ReturnType<typeof draft>>['view'];

export const fill = async (view: View): Promise<void> => {
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

export const valueOf = (view: View, selector: string): string =>
  view.host.querySelector<HTMLInputElement>(selector)?.value ?? '';

export const create = async (view: View): Promise<void> => {
  await view.click('[data-draft="create"]');
  for (let settle = 0; settle < 12; settle += 1) {
    // eslint-disable-next-line no-await-in-loop -- the chain is one request at a time
    await tick();
  }
};

/** The panel with its head, for the door: the task stub answers its read. */
export function PanelWithDoor(props: { readonly onNewTask: () => void }): ReactElement {
  const { client } = serving();
  return (
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={{ taskKey: 'Proj-Verity-Pacing', door: 'open', tab: null }}
      onChanged={() => {
        /* unread */
      }}
      onClose={() => {
        /* unread */
      }}
      onNewTask={props.onNewTask}
    />
  );
}

/** The host with buttons for each gesture, and a stop armed before each. */
export function Host(props: { readonly onStop: (why: string) => void }): ReactElement {
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
