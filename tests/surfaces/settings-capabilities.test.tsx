// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings` opens its controls from the session's own capabilities.
//
// Until now both write controls were open to everybody and the first press by
// a person who may not use them was always a refused request. `session.
// capabilities` — `POST /api/b/:businessKey/session/capabilities`, body `{}`,
// membership only — answers the grants the signed-in person holds, and the
// controls follow it.
//
// Four rules:
//
//  - `settings:manage` in the grants opens the controls. Nothing else does.
//  - A person without it gets closed controls and the reason, and never sends
//    a write nobody was going to accept.
//  - **A refused capability read closes the controls too.** A screen that
//    cannot find out what somebody may do does not guess in their favour.
//  - **An API with no such read is a different fact.** It is `unavailable`,
//    not a denial, and the screen falls back to what it did before the read
//    existed: it offers the controls, asks once, and closes them on the
//    server's refusal. Closing on an absent read would make the screen
//    unusable against every build that has not landed it yet.
//
// And the rule that outlives all four: a `SCOPE_NOT_GRANTED` on a *write*
// still closes the controls, whatever the capability read said, because a
// grant can be revoked between the read and the press.

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

const refusal = (code: string, status: number): Response =>
  json({ refused: true, code, names: [], fixes: ['no live grant covers it'] }, status);

const row = (key: string, value: unknown): Record<string, unknown> => ({
  key,
  value,
  valueType: typeof value === 'boolean' ? 'boolean' : 'number',
  updatedAt: '2026-09-23T02:15:00.000Z',
  updatedByActorId: 'actor-ada',
});

interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: { at: string; body: Record<string, unknown> }[];
}

function server(
  options: {
    readonly capabilities?: () => Response;
    readonly write?: () => Response;
  } = {},
): Stub {
  const sent: { at: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push({ at, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (at.endsWith('/session/capabilities')) {
      return (
        options.capabilities ??
        (() =>
          json({
            ok: true,
            personId: 'p-ada',
            businessKey: 'alpha',
            grants: [{ collection: 'settings', action: 'manage' }],
          }))
      )();
    }
    if (at.endsWith('/settings/read')) {
      return json({ ok: true, settings: [row('four_eyes_threshold', 500)] });
    }
    if (at.includes('/settings/set_')) {
      return (
        options.write ?? (() => json({ recordId: 'row', revision: null, detail: { value: 1200 } }))
      )();
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const screen = (fetch: typeof globalThis.fetch) => (
  <SettingsScreen
    client={new OperationsClient({ base: '/api', businessKey: 'alpha', token: 'tok', fetch })}
    grantKey="alpha:ada"
    storage={window.sessionStorage}
  />
);

const saveDisabled = (page: { find: (selector: string) => Element | null }): boolean =>
  (page.find('[data-settings="save-four-eyes"]') as HTMLButtonElement).disabled;

const writes = (stub: Stub): number =>
  stub.sent.filter((call) => call.at.includes('/settings/set_')).length;

describe('the settings controls follow the session capabilities', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('asks session.capabilities on open, with an empty body', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    const asked = api.sent.find((call) => call.at.endsWith('/session/capabilities'));
    expect(asked).toBeDefined();
    expect(asked?.at).toContain('/b/alpha/session/capabilities');
    expect(asked?.body).toEqual({});
    await page.unmount();
  });

  it('opens the controls when settings:manage is in the grants', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="capabilities"]')?.getAttribute('data-outcome')).toBe('ready');
    expect(saveDisabled(page)).toBe(false);
    await page.unmount();
  });

  it('keeps them closed for a member, and asks nothing on their behalf', async () => {
    const api = server({
      capabilities: () =>
        json({
          ok: true,
          personId: 'p-mia',
          businessKey: 'alpha',
          grants: [{ collection: 'task', action: 'read' }],
        }),
    });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(saveDisabled(page)).toBe(true);
    expect((page.find('[data-settings="save-sign-off"]') as HTMLButtonElement).disabled).toBe(true);
    // The reason is on the page, in the scope's own name.
    expect(page.find('[data-settings="capabilities-because"]')?.textContent).toContain(
      'settings:manage',
    );

    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    // Nothing was sent. This is the request the read exists to avoid.
    expect(writes(api)).toBe(0);
    await page.unmount();
  });

  it('closes the controls when the capability read itself is refused', async () => {
    const api = server({ capabilities: () => refusal('SCOPE_NOT_GRANTED', 403) });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="capabilities"]')?.getAttribute('data-outcome')).toBe(
      'denied',
    );
    expect(page.find('[data-settings="capabilities"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect(saveDisabled(page)).toBe(true);
    await page.unmount();
  });

  it('falls back to asking once when the API carries no capability read', async () => {
    const api = server({ capabilities: () => json({ error: 'not found' }, 404) });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="capabilities"]')?.getAttribute('data-outcome')).toBe(
      'unavailable',
    );
    // Open, because nobody decided anything. An absent read is not a refusal.
    expect(saveDisabled(page)).toBe(false);
    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(writes(api)).toBe(1);
    await page.unmount();
  });

  it('closes the controls when a write is refused, whatever the capabilities said', async () => {
    const api = server({ write: () => refusal('SCOPE_NOT_GRANTED', 403) });
    const page = await mount(screen(api.fetch));
    await tick();
    expect(saveDisabled(page)).toBe(false);

    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    // The grant may have been revoked since the capability read answered, and
    // the write is the newer fact.
    expect(page.find('[data-settings="closed"]')).not.toBeNull();
    expect(saveDisabled(page)).toBe(true);
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(writes(api)).toBe(1);
    await page.unmount();
  });
});
