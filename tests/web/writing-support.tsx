// SPDX-License-Identifier: AGPL-3.0-only
//
// What the MP-4-7 web suites share: a brief with facts in both heading forms,
// and a panel field mounted against a server that records every write.

import { act } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TASK_ID } from './task-page-stub.tsx';
import { json } from './perspective-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

export const BRIEF = [
  '# Pacing fix',
  '**Objective:** Hold the daily spend inside the monthly budget.',
  '',
  '## Done when',
  'Spend tracks the line for seven days.',
  'The report says so.',
  '',
  '## Notes',
  'Nothing here is a fact.',
  '**Escalation** — ask Ada before touching bids.',
].join('\n');

/** A panel field against a server that records every write it is sent. */
const STORED = { status: 200, body: { recordId: TASK_ID, revision: 5 } };

export const field = (reply?: { status: number; body: unknown }) => {
  const answer = reply ?? STORED;
  const sent: Record<string, unknown>[] = [];
  const saved: number[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (!at.endsWith('/task/update')) throw new Error(`unrouted ${at}`);
    sent.push(
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    );
    return Promise.resolve(json(answer.body, answer.status));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const onSaved = () => {
    saved.push(Date.now());
  };
  return { sent, saved, client, onSaved };
};

export const settleWrites = async (): Promise<void> => {
  await act(async () => {
    for (let turn = 0; turn < 2; turn += 1) {
      // eslint-disable-next-line no-await-in-loop -- one macrotask at a time
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

export const blur = async (view: Mounted, selector: string): Promise<void> => {
  const target = view.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
};

export const pressWith = async (
  view: Mounted,
  selector: string,
  init: KeyboardEventInit,
): Promise<void> => {
  const target = view.host.querySelector(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
};

/** A textarea's current text, by selector. */
export const textOf = (view: Mounted, selector: string): string | undefined =>
  view.host.querySelector<HTMLTextAreaElement>(selector)?.value;
