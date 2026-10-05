// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// Criterion 5: a rail-width save still unanswered through the
// previous client keeps its value over a read sent through the client a
// same-person step-up replaced it with.

import { act, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { Session, StorageLike } from '../../apps/web/src/session/token.ts';
import { layoutKey } from '../../apps/web/src/session/token.ts';
import { useLayoutStore } from '../../apps/web/src/shell/layout-store.ts';
import { mount, settle } from '../surfaces/mount.tsx';

function memory(
  initial: Record<string, string>,
): StorageLike & { readonly get: (k: string) => string | null } {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    get: (key) => items.get(key) ?? null,
  };
}

/** A client whose reads answer `stored` when released and whose saves wait to be answered. */
function clientFor(stored: Record<string, unknown>) {
  const reads: (() => void)[] = [];
  const saves: (() => void)[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL) => {
      if (String(url).endsWith('/preference/save')) {
        return new Promise<Response>((resolve) => {
          saves.push(() => {
            resolve(Response.json({ recordId: 'pref', revision: 1, detail: {} }));
          });
        });
      }
      const answer = { preferences: { ...stored } };
      return new Promise<Response>((resolve) => {
        reads.push(() => {
          resolve(Response.json(answer));
        });
      });
    }) as typeof globalThis.fetch,
  });
  const release = async (): Promise<void> => {
    await act(async () => {
      reads.shift()?.();
      await Promise.resolve();
    });
    await settle();
  };
  const answerSave = async (): Promise<void> => {
    await act(async () => {
      saves.shift()?.();
      await Promise.resolve();
    });
    await settle();
  };
  return {
    client,
    release,
    answerSave,
    pendingSaves: () => saves.length,
    pendingReads: () => reads.length,
  };
}

it('an unanswered save survives a same-person client refresh', async () => {
  const key = layoutKey('alpha');
  const storage = memory({
    [key]: JSON.stringify({ who: 'ada@example.test', layout: { 'rail.width': 200 } }),
  });
  const a = clientFor({ 'rail.width': 200 });
  const b = clientFor({ 'rail.width': 200 });
  const s1: Session = { businessKey: 'alpha', email: 'ada@example.test', sessionId: 's1' };
  const s2: Session = { businessKey: 'alpha', email: 'ada@example.test', sessionId: 's2' };
  let save: ((k: 'rail.width', v: number) => void) | null = null;
  function Probe({
    client,
    session,
  }: {
    client: OperationsClient;
    session: Session;
  }): ReactElement {
    const layout = useLayoutStore(client, session, storage);
    save = layout.save;
    return <p>{String(layout.layout['rail.width'] ?? 'none')}</p>;
  }
  const view = await mount(<Probe client={a.client} session={s1} />);
  const tabWidth = () =>
    (JSON.parse(storage.get(key) ?? '{}') as { layout?: Record<string, unknown> }).layout?.[
      'rail.width'
    ];
  try {
    // A's initial read completes with 200.
    await a.release();
    expect(view.text()).toBe('200');
    // Save 320 through A and hold the answer.
    await act(async () => {
      save?.('rail.width', 320);
      await Promise.resolve();
    });
    await settle();
    expect(a.pendingSaves(), 'A sent no save').toBe(1);
    expect(view.text()).toBe('320');
    // The step-up: the same business and person, session s2, refreshed client B.
    await view.render(<Probe client={b.client} session={s2} />);
    await settle();
    expect(b.pendingReads(), 'B sent no read').toBe(1);
    // B's read answers the pre-save width.
    await b.release();
    expect(view.text(), 'B read put the pre-save width on screen').toBe('320');
    expect(tabWidth(), 'B read put the pre-save width in the tab copy').toBe(320);
    // A's save then commits and answers with success.
    await a.answerSave();
    expect(view.text(), 'the layout was not repaired after A answered').toBe('320');
    expect(tabWidth()).toBe(320);
  } finally {
    await view.unmount();
  }
});
