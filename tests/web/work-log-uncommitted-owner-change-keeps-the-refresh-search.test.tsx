// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A switch to another reader that suspends and never commits reads nothing for
// the reader still drawn. Ada searches her own name: she has seen herself act,
// so the name filters the days and the ledger is read with no words. The new
// reader has seen nobody, so in the render that never commits the same name is
// a free word. The next floor refresh is the drawn reader's, unchanged: no
// words, down to the earlier days loaded, which stay.

import { act, startTransition, Suspense, useState, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, json } from './work-log-stand-in.tsx';

const settle = async (ms = 1): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const never = new Promise<void>(() => {});

function Gate({ pending }: { readonly pending: boolean }): null {
  if (pending) throw never;
  return null;
}

let change = (): void => {};

/** Ada's Work log, and a switch to Ben that suspends for good. */
function Page({ client }: { readonly client: OperationsClient }): ReactElement {
  const [pending, setPending] = useState(false);
  change = () => {
    startTransition(() => {
      setPending(true);
    });
  };
  return (
    <Suspense fallback={<p>Pending owner</p>}>
      <WorkLog client={client} grantKey={pending ? 'alpha:ben' : 'alpha:ada'} navigate={() => {}} />
      <Gate pending={pending} />
    </Suspense>
  );
}

function standIn() {
  const asked: Record<string, unknown>[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input, init) => {
      if (!String(input).endsWith('/task/ledger')) {
        return Promise.resolve(json({ ok: true, preferences: {} }));
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      asked.push(body);
      return Promise.resolve(json(body['before'] === null ? FIRST : SECOND));
    },
  });
  return { client, asked };
}

it('an uncommitted owner change leaves the drawn reader’s refresh its own search and earlier days', async () => {
  const { client, asked } = standIn();
  const view = await mount(<Page client={client} />);
  try {
    await settle();
    await view.click('.act__more');
    await settle();
    await view.type('input[type="search"]', 'ada');
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    expect(asked.map((body) => body['query'])).toEqual([undefined, undefined]);
    await act(() => {
      change();
    });
    expect(view.text()).not.toContain('Pending owner');
    await settle(30_000);
    expect(asked.map((body) => [body['query'], body['before']])).toEqual([
      [undefined, null],
      [undefined, '2026-09-22'],
      [undefined, null],
      [undefined, '2026-09-22'],
    ]);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
  } finally {
    await view.unmount();
  }
});
