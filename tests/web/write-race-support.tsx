// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in server for racing one screen's writes: each command is decided
// by the test's `apply`, a stored success is replayed by its operation id as
// the real register does, and the next commands can be met by a fate: never
// reaching the server, stored with the answer lost, or held until released.
// Reads (a path ending `/read`) are answered by `apply` with no fate.
//
// A harness, not a suite: nothing here runs on its own.

import { act } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';

/** `unreachable`: never reaches the server. `lose`: stored, answer lost. `hold`: answered on release. */
export type Fate = 'answer' | 'unreachable' | 'lose' | 'hold';

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

export interface Arrived {
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export const stored = (revision: number): Answer => ({
  status: 200,
  body: { recordId: 'r', revision },
});

export const refused = (code: string, status = 409): Answer => ({
  status,
  body: { refused: true, code, names: [], fixes: [] },
});

const pathOf = (url: string): string => url.slice(url.search(/\/[a-z]+\/[a-z_]+$/u));

export function raceServer(
  apply: (path: string, body: Readonly<Record<string, unknown>>) => Answer,
) {
  const sent: Arrived[] = [];
  const held: (() => void)[] = [];
  const fates: Fate[] = [];
  const register = new Map<string, Answer>();
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const path = pathOf(String(url));
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (path.endsWith('/read')) {
      const read = apply(path, body);
      return Promise.resolve(json(read.body, read.status));
    }
    const fate = fates.shift() ?? 'answer';
    if (fate === 'unreachable') return Promise.reject(new TypeError('Failed to fetch'));
    sent.push({ path, body });
    const id = String(body['operationId']);
    const answer = register.get(id) ?? apply(path, body);
    if (answer.status < 300) register.set(id, answer);
    if (fate === 'lose') return Promise.reject(new TypeError('Failed to fetch'));
    const response = json(answer.body, answer.status);
    if (fate !== 'hold') return Promise.resolve(response);
    return new Promise<Response>((resolve) => {
      held.push(() => {
        resolve(response);
      });
    });
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent, held, fates };
}

/** Answers the held command at `index`, then lets the screen draw it. */
export async function releaseHeld(held: readonly (() => void)[], index: number): Promise<void> {
  await act(async () => {
    held[index]?.();
    await Promise.resolve();
  });
  await tick();
  await tick();
}

/** The operation id the command at `index` arrived with. */
export const idOf = (sent: readonly Arrived[], index: number): unknown =>
  sent[index]?.body['operationId'];

/** Both orders two held answers can arrive in. */
export const BOTH_ORDERS = [
  ['in the order sent', 0, 1],
  ['in the reverse order', 1, 0],
] as const;
