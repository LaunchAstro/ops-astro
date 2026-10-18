// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// An earlier page on its way while the reader changes. A switch that suspends
// has not happened: the page answers into the window still drawn, and if the
// switch is then abandoned that window refreshes down to the page's days; if it
// commits, the next reader starts from the newest days with none of them. A
// switch that commits and comes back (Ada to Ben to Ada) is a new window, which
// a page sent before it joins nothing.

import { act, startTransition, Suspense, useState, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, held, json, refused } from './work-log-stand-in.tsx';

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
});

/** A Work log whose first earlier-page request is held; every other page answers at once. */
function standIn() {
  const earlier = held();
  const asked: (string | null)[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input, init) => {
      if (!String(input).endsWith('/task/ledger')) {
        return Promise.resolve(json({ ok: true, preferences: {} }));
      }
      const body = JSON.parse(String(init?.body)) as { before: string | null };
      asked.push(body.before);
      if (body.before === null) return Promise.resolve(json(FIRST));
      const pages = asked.filter((before) => before !== null).length;
      return pages === 1 ? earlier.response : Promise.resolve(json(SECOND));
    },
  });
  return { client, earlier, asked };
}

const never = new Promise<void>(() => {});

function Gate({ pending, hold }: { readonly pending: boolean; readonly hold: boolean }): null {
  if (pending && hold) throw never;
  return null;
}

let switchTo: (next: boolean) => void = () => {};

/** Ada's Work log; a switch to Ben suspends until `.let-go` is pressed. */
function Page({ client }: { readonly client: OperationsClient }): ReactElement {
  const [pending, setPending] = useState(false);
  const [hold, setHold] = useState(true);
  switchTo = (next) => {
    startTransition(() => {
      setPending(next);
    });
  };
  return (
    <Suspense fallback={<p>Pending owner</p>}>
      <WorkLog client={client} grantKey={pending ? 'alpha:ben' : 'alpha:ada'} navigate={() => {}} />
      <Gate pending={pending} hold={hold} />
      <button
        type="button"
        className="let-go"
        onClick={() => {
          setHold(false);
        }}
      />
    </Suspense>
  );
}

it('an earlier page answering during a suspended owner switch joins the drawn window, and the abandoned switch keeps it', async () => {
  const { client, earlier, asked } = standIn();
  const view = await mount(<Page client={client} />);
  try {
    await settle();
    await view.click('.act__more');
    await act(() => {
      switchTo(true);
    });
    expect(view.text()).not.toContain('Pending owner');
    earlier.release(SECOND);
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    await act(() => {
      switchTo(false);
    });
    await settle(30_000);
    expect(asked).toEqual([null, '2026-09-22', null, '2026-09-22']);
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
  } finally {
    earlier.release(SECOND);
    await view.unmount();
  }
});

it('an earlier page answering during a suspended owner switch reaches the next reader not at all once it commits', async () => {
  const { client, earlier, asked } = standIn();
  const view = await mount(<Page client={client} />);
  try {
    await settle();
    await view.click('.act__more');
    await act(() => {
      switchTo(true);
    });
    earlier.release(SECOND);
    await settle();
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    await view.click('.let-go');
    await settle();
    expect(asked).toEqual([null, '2026-09-22', null]);
    expect(drawn(view)).toEqual(['e1', 'e2']);
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

const log = (client: OperationsClient, grantKey: string): ReactElement => (
  <WorkLog client={client} grantKey={grantKey} navigate={() => {}} />
);

it.each(answers)(
  'an earlier page %s for Ada after Ada to Ben to Ada leaves the new window as drawn',
  async (_, answer) => {
    const { client, earlier, asked } = standIn();
    const view = await mount(log(client, 'alpha:ada'));
    try {
      await settle();
      await view.click('.act__more');
      await view.render(log(client, 'alpha:ben'));
      await settle();
      await view.render(log(client, 'alpha:ada'));
      await settle();
      expect(asked).toEqual([null, '2026-09-22', null, null]);
      expect(drawn(view)).toEqual(['e1', 'e2']);
      earlier.release(answer);
      await settle();
      expect(drawn(view)).toEqual(['e1', 'e2']);
      expect(view.find('[data-outcome="denied"]')).toBeNull();
      expect(view.find('.act__more')?.hasAttribute('disabled')).toBe(false);
    } finally {
      earlier.release(SECOND);
      await view.unmount();
    }
  },
);
