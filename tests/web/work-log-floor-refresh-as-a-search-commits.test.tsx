// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A floor refresh that fires in the commit that starts a new search, after the
// window's epoch has moved and before the new search's read starts, reads the
// new search from its first page: never down to the earlier days the previous
// search loaded. The tick runs from a layout effect beside the Work log.

import { act, useLayoutEffect, useState, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, event, json, page } from './work-log-stand-in.tsx';

const SEARCHED = page(
  [{ day: '2026-09-28', events: [event('h1', '2026-09-28T03:00:00Z', 'OPS-5', 'Hinge one')] }],
  false,
);

const settle = async (ms = 1): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

let arm = (): void => {};
const onInput = (): void => {
  arm();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.addEventListener('input', onInput, { capture: true });
});

afterEach(() => {
  document.removeEventListener('input', onInput, { capture: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

/** Runs the floor's next tick in the commit that arms it. */
function Ticker({ armed }: { readonly armed: boolean }): null {
  useLayoutEffect(() => {
    if (armed) vi.advanceTimersByTime(30_000);
  }, [armed]);
  return null;
}

function Page({ client }: { readonly client: OperationsClient }): ReactElement {
  const [armed, setArmed] = useState(false);
  arm = () => {
    setArmed(true);
  };
  return (
    <>
      <WorkLog client={client} grantKey="alpha:ada" navigate={() => {}} />
      <Ticker armed={armed} />
    </>
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
      if (body['query'] === 'hinge') return Promise.resolve(json(SEARCHED));
      return Promise.resolve(json(body['before'] === null ? FIRST : SECOND));
    },
  });
  return { client, asked };
}

it('a floor refresh in the commit of a new search reads only its first page', async () => {
  const { client, asked } = standIn();
  const view = await mount(<Page client={client} />);
  try {
    await settle();
    await view.click('.act__more');
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    const before = asked.length;
    await view.type('input[type="search"]', 'hinge');
    await settle();
    const since = asked.slice(before).map((body) => [body['query'], body['before']]);
    // The tick's read, then the new search's own: each from the first page.
    expect(since).toEqual([
      ['hinge', null],
      ['hinge', null],
    ]);
    expect(drawn(view)).toEqual(['h1']);
  } finally {
    await view.unmount();
  }
});
