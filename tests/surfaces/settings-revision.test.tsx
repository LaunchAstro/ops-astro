// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings` writes by exact revision, when the row has one.
//
// `business_settings` carried no revision column, so the two settings commands
// took no `expectedRevision` and two administrators writing at once could not
// be told apart — the second write simply won. Lane SETTINGS-REVISION gives the
// rows a revision and `settings.read` carries it.
//
// **The screen feature-detects it rather than requiring it.** A row that
// arrives with a `revision` is written with `expectedRevision`; a row that
// arrives without one is written exactly as it is today. There is one screen
// and it has to work against the API on both sides of that landing, and a
// screen that sent `expectedRevision: undefined` or invented a zero would be
// answering a question the server had not asked.
//
// **`VERSION_STALE` is drawn as a conflict, not as an error.** Somebody else
// wrote while this person was typing, and both numbers matter: the screen
// rereads, puts the server's value beside the draft, and waits. The second
// press is explicit and it is the person choosing to overwrite — a screen that
// retried by itself against the fresh revision would turn "somebody else got
// there first" into "you silently overrode them".

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

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

const row = (value: unknown, revision?: number): Record<string, unknown> => ({
  key: 'four_eyes_threshold',
  value,
  valueType: 'number',
  updatedAt: '2026-09-23T02:15:00.000Z',
  updatedByActorId: 'actor-bo',
  ...(revision === undefined ? {} : { revision }),
});

interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: { at: string; body: Record<string, unknown> }[];
}

/** A server whose row moves under the caller exactly once, if asked to. */
function server(
  options: {
    readonly revision?: number;
    readonly stale?: boolean;
  } = {},
): Stub {
  const sent: { at: string; body: Record<string, unknown> }[] = [];
  let value: unknown = 500;
  let revision = options.revision;
  let refuseNext = options.stale === true;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ at, body });
    if (at.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p-ada',
        businessKey: 'alpha',
        grants: [{ collection: 'settings', action: 'manage' }],
      });
    }
    if (at.endsWith('/settings/read')) {
      return json({ ok: true, settings: [row(value, revision)] });
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      if (refuseNext) {
        // Somebody else wrote 999 while this person was typing.
        refuseNext = false;
        value = 999;
        revision = (revision ?? 0) + 1;
        return json(
          {
            refused: true,
            code: 'VERSION_STALE',
            names: ['four_eyes_threshold'],
            fixes: ['reread and try again'],
          },
          409,
        );
      }
      value = body['value'];
      revision = revision === undefined ? undefined : revision + 1;
      return json({ recordId: 'row', revision: revision ?? null, detail: { value } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const screen = (fetch: typeof globalThis.fetch) => (
  <SettingsScreen
    client={new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch })}
    grantKey="alpha:ada"
    storage={window.sessionStorage}
  />
);

const writesOf = (stub: Stub): { at: string; body: Record<string, unknown> }[] =>
  stub.sent.filter((call) => call.at.includes('/settings/set_'));

describe('the settings screen writes by exact revision', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('sends the revision the read carried', async () => {
    const api = server({ revision: 7 });
    const page = await mount(screen(api.fetch));
    await tick();

    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect(writesOf(api)[0]?.body['expectedRevision']).toBe(7);
    await page.unmount();
  });

  it('sends none when the read carried none', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect('expectedRevision' in (writesOf(api)[0]?.body ?? {})).toBe(false);
    await page.unmount();
  });

  it('draws VERSION_STALE as a conflict with both numbers, and writes nothing more', async () => {
    const api = server({ revision: 7, stale: true });
    const page = await mount(screen(api.fetch));
    await tick();

    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    const conflict = page.find('[data-settings="conflict"]');
    expect(conflict).not.toBeNull();
    // The server's value, freshly reread, and the draft that lost the race.
    expect(page.find('[data-settings="conflict-server"]')?.textContent).toContain('999');
    expect(page.find('[data-settings="conflict-draft"]')?.textContent).toContain('1200');
    expect(conflict?.textContent).toContain('VERSION_STALE');
    // One write. The screen did not retry itself against the fresh revision.
    expect(writesOf(api)).toHaveLength(1);
    await page.unmount();
  });

  it('overwrites only on a second explicit press, against the reread revision', async () => {
    const api = server({ revision: 7, stale: true });
    const page = await mount(screen(api.fetch));
    await tick();

    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    await page.click('[data-settings="confirm-four-eyes"]');
    await tick();

    const again = writesOf(api);
    expect(again).toHaveLength(2);
    expect(again[1]?.body['value']).toBe(1200);
    // 8, the revision the reread found, not the 7 the first attempt held.
    expect(again[1]?.body['expectedRevision']).toBe(8);
    expect(page.find('[data-settings="conflict"]')).toBeNull();
    expect(page.find('[data-settings="four-eyes-value"]')?.textContent).toContain('1200');
    await page.unmount();
  });

  it('a press made before the reread lands writes nothing, then writes against the reread (O7)', async () => {
    const api = server({ revision: 7, stale: true });
    // Every read after the first write is held until the test lets it through.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote = false;
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const at = String(url);
      if (at.includes('/settings/set_')) wrote = true;
      if (wrote && at.endsWith('/settings/read')) await held;
      return api.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;
    const page = await mount(screen(fetch));
    await tick();

    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(page.find('[data-settings="conflict"]')).not.toBeNull();

    // The reread is still in flight: the row on screen is the one that lost.
    await page.click('[data-settings="confirm-four-eyes"]');
    await tick();
    expect(writesOf(api)).toHaveLength(1);

    release?.();
    await tick();
    expect(page.find('[data-settings="conflict-server"]')?.textContent).toContain('999');
    await page.click('[data-settings="confirm-four-eyes"]');
    await tick();

    const again = writesOf(api);
    expect(again).toHaveLength(2);
    expect(again[1]?.body['expectedRevision']).toBe(8);
    await page.unmount();
  });
});
