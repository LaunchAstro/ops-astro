// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A save answered after its screen has gone does not overwrite a deny mark
// another screen wrote in the meantime (THERMO-RECHECK-4 R4W1).
//
// Screen A's first save answers, so A holds "not refused". A second save is
// pressed and A is closed before it answers. The person opens settings again
// as screen B, whose read is refused, and B marks the refusal. A's save then
// answers in the same session. The hold is judged as it stands now, and that
// is the stored mark, not the one A last saw: a remount in the session with an
// unavailable read must draw nothing.

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
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

type ReadAnswer = 'denied' | 'unavailable';

/** An API whose second write answers only when released. */
function api(): {
  answer: ReadAnswer;
  readonly fetch: typeof globalThis.fetch;
  readonly release: () => void;
} {
  const gate: { release: () => void } = { release: () => {} };
  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const state: { answer: ReadAnswer; writes: number } = { answer: 'unavailable', writes: 0 };
  const fetch = (async (url: string | URL, init?: RequestInit) => {
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
      if (state.answer === 'denied') {
        return json(
          { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['settings:read'], fixes: [] },
          403,
        );
      }
      return json({ error: 'unavailable' }, 503);
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      state.writes += 1;
      if (state.writes > 1) await held;
      const { value } = JSON.parse(String(init?.body)) as { value: unknown };
      return json({ recordId: 'row', revision: null, detail: { value } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return Object.assign(state, {
    fetch,
    release: () => {
      gate.release();
    },
  });
}

const open = async (fetch: typeof globalThis.fetch): Promise<Mounted> => {
  const page = await mount(
    <SettingsScreen
      client={new OperationsClient({ origin: '', businessKey: 'alpha', token: ADA.token, fetch })}
      grantKey={grantKeyOf(ADA)}
      storage={window.sessionStorage}
    />,
  );
  await tick();
  return page;
};

const save = async (page: Mounted, value: string): Promise<void> => {
  await page.type('#settings-four-eyes', value);
  await page.click('[data-settings="save-four-eyes"]');
  await tick();
};

const cached = (): string =>
  Object.keys(window.sessionStorage)
    .filter((key) => key.startsWith('ops-astro.settings.'))
    .map((key) => window.sessionStorage.getItem(key) ?? '')
    .join('');

const outcome = (page: Mounted): string | null =>
  page.host.querySelector<HTMLElement>('[data-settings="read"]')?.dataset['outcome'] ?? null;

describe('a save answered after its screen closed, over another screen’s refusal', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    new SessionStore(window.sessionStorage).set(ADA);
  });

  it('leaves the deny mark, so a later mount with an unavailable read draws nothing', async () => {
    const server = api();
    const first = await open(server.fetch);
    await save(first, '1111');
    expect(cached()).toContain('1111');

    await save(first, '2222');
    await first.unmount();

    server.answer = 'denied';
    const second = await open(server.fetch);
    expect(outcome(second)).toBe('denied');
    expect(cached()).toContain('"denied":true');

    server.release();
    await tick();

    expect(cached()).toContain('"denied":true');
    expect(cached()).not.toContain('2222');
    await second.unmount();

    server.answer = 'unavailable';
    const third = await open(server.fetch);
    expect(outcome(third)).toBe('unavailable');
    expect(third.text()).not.toContain('2222');
    expect(third.text()).not.toContain('1111');
    await third.unmount();
  });
});
