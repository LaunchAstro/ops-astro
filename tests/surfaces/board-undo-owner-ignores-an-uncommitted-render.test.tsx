// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1408 (round 1), retitled by what they prove; their bodies are as written.
/* eslint-disable max-lines-per-function, unicorn/consistent-function-scoping -- the review's proof, kept as written */
import { act, startTransition, Suspense, useState } from 'react';
import { expect, it } from 'vitest';
import { BoardGallery } from './mp-5-board-gallery-fixture.tsx';
import { mount } from './mount.tsx';

it('an uncommitted toolbar move cannot redirect undo to the other board', async () => {
  const committedBar = document.createElement('div');
  const pendingBar = document.createElement('div');
  document.body.append(committedBar, pendingBar);
  let move = () => {};
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
    move = () => startTransition(() => setPending(true));
    return (
      <Suspense fallback={<p>Loading</p>}>
        <section data-sol-page>
          <BoardGallery width={1200} viewport={1480} bar={pending ? pendingBar : committedBar} />
        </section>
        <Gate pending={pending} />
      </Suspense>
    );
  }
  const view = await mount(
    <>
      <section data-sol-panel>
        <BoardGallery width={1200} viewport={1480} />
      </section>
      <Page />
    </>,
  );
  try {
    await view.click('[data-sol-panel] th[data-key="due"] button');
    await view.click('[data-sol-page] th[data-key="name"] button');
    const key = () => {
      const target = committedBar.querySelector('[data-undo]');
      if (target === null) throw new Error('committed page toolbar missing');
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    // Control: the committed toolbar owns its key until a render is suspended.
    await act(key);
    expect(view.find('[data-sol-panel] th[data-key="due"]')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(view.find('[data-sol-page] th[data-key="name"]')?.getAttribute('aria-sort')).toBe(
      'none',
    );
    await view.click('[data-sol-page] th[data-key="name"] button');
    await act(() => {
      move();
    });
    expect(suspended).toBeGreaterThan(0);
    expect(pendingBar.querySelector('[data-undo]')).toBeNull();
    await act(key);
    expect(view.find('[data-sol-panel] th[data-key="due"]')?.getAttribute('aria-sort')).toBe(
      'ascending',
    );
    expect(view.find('[data-sol-page] th[data-key="name"]')?.getAttribute('aria-sort')).toBe(
      'none',
    );
  } finally {
    await view.unmount();
    committedBar.remove();
    pendingBar.remove();
  }
});
