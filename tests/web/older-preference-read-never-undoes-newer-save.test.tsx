// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A preference read that left before a save, or while one was still
// unanswered, holds an older value for that key; it lands without undoing the
// save (#541), on the rail and dock layout, a task screen's saved flag, and
// Settings ▸ You.

import { act, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { YouGroups } from '../../apps/web/src/screens/settings/you.tsx';
import { useSavedFlag } from '../../apps/web/src/screens/task/saved-flag.ts';
import { useLayoutStore } from '../../apps/web/src/shell/layout-store.ts';
import { mount, settle } from '../surfaces/mount.tsx';

/** A preference store whose reads wait to be released, oldest first, and whose saves answer at once. */
function store(stored: Record<string, unknown>) {
  const reads: (() => void)[] = [];
  const saved: Record<string, unknown>[] = [];
  const refuse = new Set<string>();
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: ((url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/preference/save')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        saved.push(body);
        const key = String(body['preference']);
        if (refuse.has(key)) {
          return Promise.resolve(
            Response.json(
              { refused: true, code: 'FIELD_VALUE_INVALID', names: [key], fixes: [] },
              { status: 422 },
            ),
          );
        }
        return Promise.resolve(Response.json({ recordId: 'pref', revision: 1, detail: {} }));
      }
      // The answer is what the store held when the read left.
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
  return { client, saved, refuse, release, pending: () => reads.length };
}

it('the layout keeps a released rail width over a read that left before it', async () => {
  const at = store({ 'rail.width': 200 });
  let save: ((key: 'rail.width', value: number) => void) | null = null;
  const session = { businessKey: 'alpha', email: 'ada@example.test', sessionId: 's-ada' };
  function Probe(): ReactElement {
    const layout = useLayoutStore(at.client, session, null);
    save = layout.save;
    return <p>{String(layout.layout['rail.width'] ?? 'none')}</p>;
  }
  const view = await mount(<Probe />);
  try {
    await act(async () => {
      save?.('rail.width', 320);
      await Promise.resolve();
    });
    await settle();
    await at.release();
    expect(view.text(), 'the older read put the earlier width back').toBe('320');
  } finally {
    await view.unmount();
  }
});

it('a saved flag keeps the choice made before its read answered, and saves it', async () => {
  const at = store({ 'history.showTrail': false });
  let choose: ((next: boolean) => void) | null = null;
  function Probe(): ReactElement {
    const [on, set] = useSavedFlag(at.client, 'history.showTrail');
    choose = set;
    return <p>{on ? 'on' : 'off'}</p>;
  }
  const view = await mount(<Probe />);
  try {
    await act(async () => {
      choose?.(true);
      await Promise.resolve();
    });
    await at.release();
    expect(view.text(), 'the older read undid the choice').toBe('on');
    expect(at.saved.map((body) => body['value'])).toEqual([true]);
  } finally {
    await view.unmount();
  }
});

it('a refusal’s reread does not undo a choice still unanswered when the reread left', async () => {
  const at = store({ appearance: 'light', 'tips.enabled': true });
  at.refuse.add('tips.enabled');
  const view = await mount(<YouGroups client={at.client} grantKey="alpha:ada:0" storage={null} />);
  const selected = () =>
    view.find('[data-pref="appearance"] button[aria-pressed="true"]')?.textContent;
  try {
    await at.release();
    expect(selected()).toBe('Light');
    // Tips are refused; Dark is chosen while that refusal is on its way.
    await view.click('#settings-tips');
    await view.click('[data-pref="appearance"] button:nth-child(2)');
    await settle();
    // The refusal's reread left with the store still holding Light.
    expect(at.pending(), 'the refusal sent no reread').toBe(1);
    await at.release();
    expect(at.saved.map((body) => body['preference'])).toEqual(['tips.enabled', 'appearance']);
    expect(selected(), 'the reread put the older appearance back').toBe('Dark');
  } finally {
    await view.unmount();
    delete document.documentElement.dataset['themePreference'];
    delete document.documentElement.dataset['themeFade'];
  }
});
