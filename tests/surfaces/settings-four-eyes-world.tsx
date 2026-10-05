// SPDX-License-Identifier: AGPL-3.0-only
//
// One business's settings over a stubbed API, for the four-eyes save cases:
// the row moves under the caller when asked, a read can be made to fail, and a
// write can be refused for a stale money sign-in or left unanswered.

import { act } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const row = (value: unknown, revision: number): Record<string, unknown> => ({
  key: 'four_eyes_threshold',
  value,
  valueType: 'number',
  updatedAt: '2026-10-05T02:15:00.000Z',
  updatedByActorId: 'actor-bo',
  revision,
});

export interface Sent {
  readonly at: string;
  readonly body: Record<string, unknown>;
}

/** What the next write or read does instead of answering normally. */
export type Next = 'stale' | 'step-up' | 'lost' | 'read-fails' | null;

export interface FourEyesWorld {
  readonly sent: Sent[];
  readonly fetch: typeof globalThis.fetch;
  /** The next write answers this way. */
  write: Next;
  /** The next settings read answers this way. */
  read: Next;
  readonly server: () => { readonly value: unknown; readonly revision: number };
  readonly client: (businessKey?: string) => OperationsClient;
}

const CAPABILITIES = {
  ok: true,
  personId: 'p-ada',
  businessKey: 'alpha',
  grants: [
    { collection: 'settings', action: 'manage' },
    { collection: 'spend', action: 'decide' },
  ],
};

const STEP_UP = {
  refused: true,
  code: 'STEP_UP_REQUIRED',
  names: [],
  fixes: ['Confirm with your code.'],
};

const STALE = { refused: true, code: 'VERSION_STALE', names: ['four_eyes_threshold'], fixes: [] };

interface Row {
  value: unknown;
  revision: number;
}

/** The threshold write: answered as `next` says, else stored. */
function write(held: Row, next: Next, body: Record<string, unknown>): Promise<Response> {
  if (next === 'lost') return Promise.reject(new TypeError('Failed to fetch'));
  if (next === 'step-up') return Promise.resolve(json(STEP_UP, 403));
  if (next === 'stale') {
    // Another administrator wrote 999 first.
    held.value = 999;
    held.revision += 1;
    return Promise.resolve(json(STALE, 409));
  }
  held.value = body['value'];
  held.revision += 1;
  return Promise.resolve(json({ recordId: 'row', revision: held.revision, detail: held }));
}

export function fourEyesWorld(start: Row): FourEyesWorld {
  const held: Row = { ...start };
  const world: FourEyesWorld = {
    sent: [],
    write: null,
    read: null,
    server: () => ({ ...held }),
    client: (businessKey = 'alpha') =>
      new OperationsClient({ origin: '', businessKey, signedIn: true, fetch: world.fetch }),
    fetch: ((url: string | URL, init?: RequestInit) => {
      const at = String(url);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      world.sent.push({ at, body });
      if (at.endsWith('/session/capabilities')) return Promise.resolve(json(CAPABILITIES));
      if (at.endsWith('/settings/read')) {
        const fails = world.read === 'read-fails';
        world.read = null;
        if (fails) return Promise.resolve(new Response(null, { status: 503 }));
        return Promise.resolve(json({ ok: true, settings: [row(held.value, held.revision)] }));
      }
      if (at.endsWith('/settings/set_four_eyes_threshold')) {
        const next = world.write;
        world.write = null;
        return write(held, next, body);
      }
      if (at.endsWith('/account/sessions/list')) return Promise.resolve(json({ sessions: [] }));
      return Promise.resolve(json({}));
    }) as unknown as typeof globalThis.fetch,
  };
  return world;
}

export const writesOf = (world: FourEyesWorld): Sent[] =>
  world.sent.filter((call) => call.at.includes('/settings/set_'));
