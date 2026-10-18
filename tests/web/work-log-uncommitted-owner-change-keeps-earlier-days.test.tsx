// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Proof from the independent review of the Work log refresh, retitled by what it proves; its body is as written.
/* oxlint-disable max-lines-per-function, require-await, unicorn/consistent-function-scoping -- the review's proof, kept as written */
import { act, startTransition, Suspense, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { WorkLog } from '../../apps/web/src/screens/projects/WorkLog.tsx';
import { mount } from '../surfaces/mount.tsx';
import { FIRST, SECOND, drawn, json } from './work-log-stand-in.tsx';

it('an uncommitted owner change cannot discard earlier days on an unchanged refresh', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const asked: (string | null)[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (input, init) => {
      if (!String(input).endsWith('/task/ledger')) return json({ ok: true, preferences: {} });
      const body = JSON.parse(String(init?.body)) as { before: string | null };
      asked.push(body.before);
      return json(body.before === null ? FIRST : SECOND);
    },
  });
  let change = () => {};
  let suspended = 0;
  const never = new Promise<void>(() => {});
  function Gate({ pending }: { readonly pending: boolean }) {
    if (pending) {
      suspended += 1;
      throw never;
    }
    return null;
  }
  function Page() {
    const [pending, setPending] = useState(false);
    change = () => startTransition(() => setPending(true));
    return (
      <Suspense fallback={<p>Pending owner</p>}>
        <WorkLog
          client={client}
          grantKey={pending ? 'alpha:ben' : 'alpha:ada'}
          navigate={() => {}}
        />
        <Gate pending={pending} />
      </Suspense>
    );
  }
  const view = await mount(<Page />);
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await view.click('.act__more');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    await act(() => {
      change();
    });
    expect(suspended).toBeGreaterThan(0);
    expect(view.text()).not.toContain('Pending owner');
    expect(drawn(view)).toEqual(['e1', 'e2', 'e3']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(drawn(view), JSON.stringify(asked)).toEqual(['e1', 'e2', 'e3']);
  } finally {
    await view.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
