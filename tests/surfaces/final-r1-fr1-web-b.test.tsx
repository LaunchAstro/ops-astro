// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1, lane FR1-WEB-B: the screen-level items.
//
// #32  A conflict whose reread is still in flight draws no server value: the
//      row in hand is the one that lost (docs/local/WEB.md:346-348, :498-501).
// #69  The settings screen describes the four-eyes band and client sign-off as
//      stored and shown, not as rules an operation applies
//      (docs/local/AUTHORITY.md:499-501).
// #46  The sign-in failure is paired with its control and announced
//      (packages/ui/src/primitives/Absence.tsx:67-74).

import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
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

/** A settings server whose four-eyes row moves to 999 under the first write. */
function staleServer(): typeof globalThis.fetch {
  let value: unknown = 500;
  let revision = 7;
  let refuseNext = true;
  return (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (at.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p-ada',
        businessKey: 'alpha',
        grants: [{ collection: 'settings', action: 'manage' }],
      });
    }
    if (at.endsWith('/settings/read')) {
      return json({
        ok: true,
        settings: [
          {
            key: 'four_eyes_threshold',
            value,
            valueType: 'number',
            updatedAt: '2026-09-23T02:15:00.000Z',
            updatedByActorId: 'actor-bo',
            revision,
          },
        ],
      });
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      if (refuseNext) {
        refuseNext = false;
        value = 999;
        revision += 1;
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
      revision += 1;
      return json({ recordId: 'row', revision, detail: { value } });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
}

const settingsScreen = (fetch: typeof globalThis.fetch) => (
  <SettingsScreen
    client={new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch })}
    grantKey="alpha:ada"
    storage={window.sessionStorage}
  />
);

describe('FR1-WEB-B #32: a conflict whose reread is in flight', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('claims no server value until the reread answers, then draws the reread', async () => {
    const api = staleServer();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote = false;
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const at = String(url);
      if (at.includes('/settings/set_')) wrote = true;
      if (wrote && at.endsWith('/settings/read')) await held;
      return api(url, init);
    }) as unknown as typeof globalThis.fetch;
    const page = await mount(settingsScreen(fetch));
    await tick();

    await page.type('#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    const during = page.find('[data-settings="conflict-server"]')?.textContent ?? '';
    expect(page.find('[data-settings="conflict"]')).not.toBeNull();
    // 500 is the value that lost. Drawing it as what the server holds is a
    // claim the screen knows to be stale.
    expect(during).not.toContain('500');
    expect(during).toContain('reading');

    release?.();
    await tick();
    expect(page.find('[data-settings="conflict-server"]')?.textContent).toContain('999');
    await page.unmount();
  });
});

describe('FR1-WEB-B #69: the settings copy', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('says the two settings are stored and not yet applied by any operation', async () => {
    const page = await mount(settingsScreen(staleServer()));
    await tick();
    const text = page.text();
    // No present-tense claim that the setting changes who must agree.
    expect(text).not.toMatch(/second person must agree/u);
    expect(text).not.toMatch(/each changes who must agree/u);
    expect(text).not.toMatch(/Whether the client must agree before work is counted/u);
    expect(page.all('[data-settings="not-applied"]')).toHaveLength(2);
    for (const note of page.all('[data-settings="not-applied"]')) {
      expect(note.textContent).toMatch(/no operation applies it yet/u);
    }
    await page.unmount();
  });
});

describe('FR1-WEB-B #46: the sign-in failure', () => {
  it('is paired with the password control and sits in an alert region', async () => {
    const gotrue = (async () =>
      json(
        { error: 'invalid_grant', error_description: 'Invalid login credentials' },
        400,
      )) as unknown as typeof globalThis.fetch;
    const page = await mount(
      <SignIn
        gotrueUrl="http://identity.invalid"
        fetch={gotrue}
        onSignedIn={() => {}}
        ended={null}
      />,
    );
    const password = (): Element | null => page.find('#signin-password');
    expect(password()?.getAttribute('aria-invalid')).not.toBe('true');
    expect(password()?.hasAttribute('aria-describedby')).toBe(false);

    await page.type('#signin-email', 'ada@alpha.local');
    await page.type('#signin-password', 'wrong');
    await act(async () => {
      page.find('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await tick();

    const error = page.find('#signin-password-error');
    expect(error).not.toBeNull();
    expect(password()?.getAttribute('aria-invalid')).toBe('true');
    expect(password()?.getAttribute('aria-describedby')).toBe('signin-password-error');
    expect(error?.closest('[role="alert"]')).not.toBeNull();
    await page.unmount();
  });
});
