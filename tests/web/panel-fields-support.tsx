// SPDX-License-Identifier: AGPL-3.0-only
//
// The server stand-in and the mount the MP-4-8 field-edit suites share: one
// task, two people, every command recorded by its path.
//
// A harness, not a suite: nothing here runs on its own.

import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskPanel } from '../../apps/web/src/screens/task/Panel.tsx';
import { task, tick } from './task-page-stub.tsx';
import { json, mount } from './perspective-support.tsx';

export const KEY = 'Proj-Verity-Pacing';

export const PEOPLE = [
  { personId: 'p-ada', name: 'Ada' },
  { personId: 'p-grace', name: 'Grace' },
];

export interface Sent {
  readonly to: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** A server answering one task and two people, recording every command by its path. */
export function serving(
  over: Readonly<Record<string, unknown>> = {},
  /** The business's tag vocabulary `tag.list` answers (MP-4-11). */
  vocabulary: readonly { readonly id: string; readonly name: string }[] = [],
): {
  readonly client: OperationsClient;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const where = String(url);
    if (where.endsWith('/person/list')) {
      return Promise.resolve(json({ ok: true, persons: PEOPLE }));
    }
    if (where.endsWith('/task/queue')) {
      return Promise.resolve(json({ ok: true, queue: [], alerts: [], outages: [] }));
    }
    if (where.endsWith('/task/execution')) return Promise.resolve(json({ ok: false }));
    if (where.includes('/live/task/')) return Promise.resolve(new Response(null, { status: 404 }));
    if (where.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: task(over) }));
    if (where.endsWith('/tag/list')) return Promise.resolve(json({ ok: true, tags: vocabulary }));
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ to: where.slice(where.search(/\/[a-z]+\/[a-z_]+$/u)), body });
    // A new tag answers with its identifier, as `tag.create` does.
    const detail = where.endsWith('/tag/create')
      ? { tagId: 'g-new', name: body['name'] }
      : undefined;
    return Promise.resolve(json({ recordId: 'r', revision: 5, detail }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    sent,
  };
}

export const panel = async (
  client: OperationsClient,
  on: {
    readonly changed?: () => void;
    readonly close?: () => void;
    /** What the panel hands its host to stop before leaving (MP-4-13). */
    readonly leaving?: (stop: (() => void) | null) => void;
  } = {},
) => {
  const view = await mount(
    <TaskPanel
      client={client}
      grantKey="alpha:member"
      opening={{ taskKey: KEY, door: 'open', tab: null }}
      onChanged={
        on.changed ??
        (() => {
          /* unread */
        })
      }
      onClose={
        on.close ??
        (() => {
          /* unread */
        })
      }
      {...(on.leaving === undefined ? {} : { onLeaving: on.leaving })}
    />,
  );
  await tick();
  return view;
};
