// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings` writes the tab's storage when something answers, never inside a
// state updater (THERMO-RECHECK-3 R3C1).
//
// React runs an updater on its next render, not when it is queued, and may run
// it twice. A storage write there is deferred past an unmount, so an answered
// save is lost, and past the denial's effect, so the save overwrites the deny
// mark. This file records the call stack of every storage write while the
// screen saves, is refused and is answered, and fails if any write came
// through `basicStateReducer`, the frame React calls every `useState` updater
// from, whether eagerly on dispatch or during the render.

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SessionStore, grantKeyOf, type Session } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from './mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ADA: Session = { token: 'tok-ada', businessKey: 'alpha', email: 'ada@alpha.local' };

type ReadAnswer = 'rows' | 'denied' | 'unavailable';

function api(): { answer: ReadAnswer; readonly fetch: typeof globalThis.fetch } {
  const held: { answer: ReadAnswer } = { answer: 'unavailable' };
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p',
        businessKey: 'alpha',
        grants: [{ collection: 'settings', action: 'manage' }],
      });
    }
    if (at.endsWith('/settings/read')) {
      if (held.answer === 'denied') {
        return json(
          { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['settings:read'], fixes: [] },
          403,
        );
      }
      if (held.answer === 'unavailable') return json({ error: 'unavailable' }, 503);
      return json({ ok: true, settings: [] });
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      return json({ recordId: 'row', revision: null, detail: { value: 7777 } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return Object.assign(held, { fetch });
}

/** The tab's storage, with the stack of every write to a settings slot. */
function recording(): { readonly storage: Storage; readonly writes: string[] } {
  const writes: string[] = [];
  const real = window.sessionStorage;
  const note = (key: string): void => {
    if (key.startsWith('ops-astro.settings.')) writes.push(new Error('storage write').stack ?? '');
  };
  const storage = {
    get length() {
      return real.length;
    },
    key: (index: number) => real.key(index),
    getItem: (key: string) => real.getItem(key),
    setItem: (key: string, value: string) => {
      note(key);
      real.setItem(key, value);
    },
    removeItem: (key: string) => {
      note(key);
      real.removeItem(key);
    },
    clear: () => {
      real.clear();
    },
  } satisfies Storage;
  return { storage, writes };
}

const open = async (fetch: typeof globalThis.fetch, storage: Storage): Promise<Mounted> => {
  const page = await mount(
    <SettingsScreen
      client={new OperationsClient({ origin: '', businessKey: 'alpha', token: ADA.token, fetch })}
      grantKey={grantKeyOf(ADA)}
      storage={storage}
    />,
  );
  await tick();
  return page;
};

const save = async (page: Mounted): Promise<void> => {
  await page.type('#settings-four-eyes', '7777');
  await page.click('[data-settings="save-four-eyes"]');
  await tick();
};

describe('settings storage writes', () => {
  const limit = Error.stackTraceLimit;
  beforeEach(() => {
    Error.stackTraceLimit = 100;
    window.sessionStorage.clear();
    new SessionStore(window.sessionStorage).set(ADA);
  });
  afterEach(() => {
    Error.stackTraceLimit = limit;
  });

  it('none sits inside a state updater: save, refusal, save while refused, lift, save', async () => {
    const server = api();
    const { storage, writes } = recording();
    const page = await open(server.fetch, storage);

    await save(page);
    server.answer = 'denied';
    await save(page);
    server.answer = 'unavailable';
    await save(page);
    server.answer = 'rows';
    await save(page);
    server.answer = 'unavailable';
    await save(page);
    await page.unmount();

    // keep, deny, lift and a keep after it, at the least: the check saw writes.
    expect(writes.length).toBeGreaterThanOrEqual(4);
    expect(writes.filter((stack) => stack.includes('basicStateReducer'))).toEqual([]);
  });
});
