// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// `Load earlier days` pressed in the commit that starts a new search, after the
// window's epoch has moved and before the new search's read starts: the window
// still drawn is the previous search's, so the press sends nothing, and nothing
// joins or withdraws the new search's window or holds its button disabled. The press runs from a layout effect beside the Work
// log, the one place a test can reach between the two; a person reaches it when
// the commit is not a discrete one (a transition, or an answer that moves the
// query), whose passive effects wait for the next frame.

import { act, useLayoutEffect, useState, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, event, held, json, page, refused } from './work-log-stand-in.tsx';

/** The searched window: the same two days as FIRST, other events. */
const SEARCHED = page(
  [
    { day: '2026-09-28', events: [event('h1', '2026-09-28T03:00:00Z', 'OPS-5', 'Hinge one')] },
    { day: '2026-09-22', events: [event('h2', '2026-09-22T03:00:00Z', 'OPS-6', 'Hinge two')] },
  ],
  true,
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

/** Presses `Load earlier days` in the commit that arms it. */
function Presser({ armed }: { readonly armed: boolean }): null {
  useLayoutEffect(() => {
    if (armed) (document.querySelector('.act__more') as HTMLElement | null)?.click();
  }, [armed]);
  return null;
}

/** The Work log, armed by the next keystroke to press in that keystroke's commit. */
function Page({ client }: { readonly client: OperationsClient }): ReactElement {
  const [armed, setArmed] = useState(false);
  arm = () => {
    setArmed(true);
  };
  return (
    <>
      <WorkLog client={client} grantKey="alpha:ada" navigate={() => {}} />
      <Presser armed={armed} />
    </>
  );
}

/** Every earlier page is the held one; first pages answer at once, searched or not. */
function standIn(earlier: Promise<Response>) {
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
      if (body['before'] !== null) return earlier;
      return Promise.resolve(json(body['query'] === 'hinge' ? SEARCHED : FIRST));
    },
  });
  return { client, asked };
}

async function pressedAsTheSearchCommits() {
  const earlier = held();
  const { client, asked } = standIn(earlier.response);
  const view = await mount(<Page client={client} />);
  await settle();
  expect(drawn(view)).toEqual(['e1', 'e2']);
  await view.type('input[type="search"]', 'hinge');
  await settle();
  // The press found the previous search's window drawn and sent nothing for it.
  expect(asked.map((body) => [body['query'], body['before']])).toEqual([
    [undefined, null],
    ['hinge', null],
  ]);
  expect(drawn(view)).toEqual(['h1', 'h2']);
  return { view, earlier };
}

it('the new search’s button is not held disabled by a page pressed for the previous window', async () => {
  const { view, earlier } = await pressedAsTheSearchCommits();
  try {
    expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(false);
  } finally {
    earlier.release(SECOND);
    await view.unmount();
  }
});

const answers = [
  ['granted', SECOND],
  ['refused', refused('SCOPE_NOT_GRANTED', ['task'])],
] as const;

it.each(answers)(
  'a page pressed for the previous search, %s, leaves the new search’s days as drawn',
  async (_, answer) => {
    const { view, earlier } = await pressedAsTheSearchCommits();
    try {
      earlier.release(answer);
      await settle();
      expect(drawn(view)).toEqual(['h1', 'h2']);
      expect(view.find('[data-outcome="denied"]')).toBeNull();
    } finally {
      earlier.release(SECOND);
      await view.unmount();
    }
  },
);
