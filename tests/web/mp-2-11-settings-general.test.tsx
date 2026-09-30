// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11: Settings General in the browser. You (appearance, guided tips),
// Notifications (CS-2.17) and This business (the built four-eyes and client
// sign-off rows) on one page, each saved through the command that owns it:
// `preference.save` for the person's own keys, the settings commands for the
// business's. The server legs (the store, the tip dismissal, the refusals and
// the crossings) are proved in tests/api and tests/identity; these prove what
// the page draws and sends.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SettingsGeneralScreen } from '../../apps/web/src/screens/SettingsGeneral.tsx';
import { APPEARANCE_KEY, useStoredAppearance } from '../../apps/web/src/appearance.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const root = join(import.meta.dirname, '../..');

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly at: string;
  readonly body: Record<string, unknown>;
}

/** The API the page meets: the person's own preferences, and the business's two settings. */
function server(
  options: {
    readonly preferences?: Readonly<Record<string, unknown>>;
    readonly refuseFourEyes?: { readonly code: string; readonly fixes: readonly string[] };
  } = {},
) {
  const sent: Sent[] = [];
  const route = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ at, body });
    if (at.endsWith('/preference/read'))
      return json({ ok: true, preferences: options.preferences ?? {} });
    if (at.endsWith('/settings/read'))
      return json({
        ok: true,
        settings: [
          { key: 'four_eyes_threshold', value: 500, revision: 3, updatedAt: null },
          { key: 'client_sign_off_required', value: false, revision: 1, updatedAt: null },
        ],
      });
    if (at.endsWith('/session/capabilities'))
      return json({
        ok: true,
        personId: 'p-ada',
        businessKey: 'alpha',
        grants: [
          { collection: 'settings', action: 'manage' },
          { collection: 'spend', action: 'decide' },
        ],
      });
    if (at.endsWith('/settings/set_four_eyes_threshold') && options.refuseFourEyes !== undefined)
      return json(
        { refused: true, names: [], ...options.refuseFourEyes, code: options.refuseFourEyes.code },
        403,
      );
    return json({ ok: true, recordId: 'r-1', revision: 4 });
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(route(url, init))) as typeof globalThis.fetch;
  return { fetch, sent };
}

const saves = (api: ReturnType<typeof server>): readonly Record<string, unknown>[] =>
  api.sent.filter((call) => call.at.endsWith('/preference/save')).map((call) => call.body);

const client = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });

const page = (fetch: typeof globalThis.fetch): ReactElement => (
  <SettingsGeneralScreen
    client={client(fetch)}
    grantKey="alpha:ada"
    storage={window.sessionStorage}
  />
);

/** The button in a group whose words are these. */
function button(mounted: Mounted, group: string, words: string): HTMLButtonElement {
  const found = mounted
    .all(`[data-pref="${group}"] button`)
    .find((each) => each.textContent?.trim() === words);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${words} button in ${group}`);
  return found;
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

let mounted: Mounted | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  window.sessionStorage.clear();
  const html = document.documentElement;
  delete html.dataset['themePreference'];
  delete html.dataset['themeFade'];
});

it('MP-2-11 appearance repaints: Dark applies at once with the 500ms crossfade and is saved for the person', async () => {
  const api = server();
  mounted = await mount(page(api.fetch));
  await tick();
  // Nothing stored: System, the default, is the one pressed.
  expect(button(mounted, 'appearance', 'System').getAttribute('aria-pressed')).toBe('true');

  await press(button(mounted, 'appearance', 'Dark'));
  // At once: the root carries the choice before the save has answered.
  const html = document.documentElement;
  expect(html.dataset['themePreference']).toBe('dark');
  expect(html.dataset['themeFade']).toBe('');
  await tick();
  expect(saves(api)).toContainEqual(
    expect.objectContaining({ preference: 'appearance', value: 'dark' }),
  );
  expect(window.sessionStorage.getItem(APPEARANCE_KEY)).toBe('dark');

  // The crossfade is 500ms, and only while the fade marker is on.
  const css = readFileSync(join(root, 'apps/web/src/styles/6-slice.css'), 'utf8');
  expect(css).toMatch(/\[data-theme-fade\][^{]*\{[^}]*500ms/u);
});

it('MP-2-11 theme replayed before paint: signed in the stored appearance applies, signed out it goes', async () => {
  // Signed in: the person's stored appearance is applied and kept for this tab.
  const api = server({ preferences: { appearance: 'dark' } });
  function Probe(): null {
    useStoredAppearance(client(api.fetch), 'alpha:ada', window.sessionStorage);
    return null;
  }
  mounted = await mount(<Probe />);
  await tick();
  expect(document.documentElement.dataset['themePreference']).toBe('dark');
  expect(window.sessionStorage.getItem(APPEARANCE_KEY)).toBe('dark');
  await mounted.unmount();
  mounted = null;

  // Signed out: the copy goes, so the next person's session never opens in it.
  function SignedOut(): null {
    useStoredAppearance(client(api.fetch), null, window.sessionStorage);
    return null;
  }
  mounted = await mount(<SignedOut />);
  await tick();
  expect(document.documentElement.dataset['themePreference']).toBeUndefined();
  expect(window.sessionStorage.getItem(APPEARANCE_KEY)).toBeNull();
});

it('MP-2-11 theme replayed before paint: a reload opens in the appearance this tab kept', () => {
  window.sessionStorage.setItem(APPEARANCE_KEY, 'dark');
  // A reload: MP-1-1's step, run on a fresh root with no preference handed
  // to it and a light system, opens dark from what this tab kept.
  const html = readFileSync(join(root, 'apps/web/index.html'), 'utf8');
  const head = new DOMParser().parseFromString(html, 'text/html').head;
  const step = head.querySelector('script')?.textContent ?? '';
  const original = document.documentElement;
  const fresh = document.createElement('html');
  document.replaceChild(fresh, original);
  const matchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => {
      // A light system that never changes.
    },
  })) as unknown as typeof window.matchMedia;
  try {
    window.eval(step);
    expect(fresh.dataset['theme']).toBe('dark');
    expect(fresh.dataset['themePreference']).toBe('dark');
  } finally {
    document.replaceChild(original, fresh);
    window.matchMedia = matchMedia;
  }
});

it('MP-2-11 tips off: the switch saves tips.enabled false and the reset says why it is closed', async () => {
  const api = server({ preferences: { 'tips.dismissed': { 'agency:inbox#triage': 1 } } });
  mounted = await mount(page(api.fetch));
  await tick();
  const tips = mounted.find('[data-pref="tips"] [role="switch"]');
  expect(tips?.getAttribute('aria-checked')).toBe('true');
  await press(tips as HTMLElement);
  await tick();
  expect(saves(api)).toContainEqual(
    expect.objectContaining({ preference: 'tips.enabled', value: false }),
  );
  expect(mounted.find('[data-pref="tips"] [role="switch"]')?.getAttribute('aria-checked')).toBe(
    'false',
  );
  const reset = button(mounted, 'tips-reset', 'Bring back 1 dismissed tip');
  expect(reset.disabled).toBe(true);
  expect(mounted.find('[data-pref="tips-reset"]')?.textContent).toContain('Guided tips are off');
});

it('MP-2-11 tip reset: the bring-back count is derived from the store and the reset clears it', async () => {
  const api = server({
    preferences: { 'tips.dismissed': { 'agency:inbox#triage': 1, 'agency:projects#board': 2 } },
  });
  mounted = await mount(page(api.fetch));
  await tick();
  const reset = button(mounted, 'tips-reset', 'Bring back 2 dismissed tips');
  expect(reset.disabled).toBe(false);
  await press(reset);
  await tick();
  expect(saves(api)).toContainEqual(
    expect.objectContaining({ preference: 'tips.dismissed', value: {} }),
  );
  // None dismissed now: closed, with its reason.
  const none = button(mounted, 'tips-reset', 'Bring back 0 dismissed tips');
  expect(none.disabled).toBe(true);
  expect(mounted.find('[data-pref="tips-reset"]')?.textContent).toContain('No tips are dismissed');
});

it('MP-2-11 decision not silenced: decisions and incidents are drawn always on, with no control', async () => {
  const api = server();
  mounted = await mount(page(api.fetch));
  await tick();
  const never = mounted.find('[data-notify="never-quiet"]');
  expect(never?.textContent).toContain('Decisions');
  expect(never?.textContent).toContain('Incidents');
  expect(never?.textContent).toContain('cannot be silenced');
  expect(never?.querySelectorAll('button, input, select')).toHaveLength(0);
  // In-app is always on: drawn on and locked, with the reason.
  const inApp = mounted.find('[data-notify="in-app"] [role="switch"]');
  expect(inApp?.getAttribute('aria-checked')).toBe('true');
  expect((inApp as HTMLButtonElement).disabled).toBe(true);
  // Nothing on this group writes.
  expect(api.sent.filter((call) => call.at.includes('/notifications/'))).toHaveLength(0);
});

it('MP-2-11 email not yet connected: email is drawn with the not-connected treatment and no choice', async () => {
  const api = server();
  mounted = await mount(page(api.fetch));
  await tick();
  const email = mounted.find('[data-notify="email"]');
  expect(email?.querySelector('[data-voice="not-connected"]')).not.toBeNull();
  expect(email?.textContent).toContain('Instant');
  expect(email?.textContent).toContain('Daily batch');
  expect(email?.querySelectorAll('button:not([disabled]), input, select')).toHaveLength(0);
});

it('MP-2-11 business rows: the built rows sit in This business, and a stale sign-in shows the fix, never the code', async () => {
  const api = server({
    refuseFourEyes: {
      code: 'STEP_UP_REQUIRED',
      fixes: ['Sign in again with the code from your authenticator app, then retry.'],
    },
  });
  mounted = await mount(page(api.fetch));
  await tick();
  const business = mounted.find('[data-pref="business"]');
  expect(business?.textContent).toContain('This business');
  expect(business?.querySelector('[data-settings="save-four-eyes"]')).not.toBeNull();
  expect(business?.querySelector('[data-settings="save-sign-off"]')).not.toBeNull();

  await mounted.type('#settings-four-eyes', '900');
  await mounted.click('[data-settings="save-four-eyes"]');
  await tick();
  const said = mounted.text();
  expect(said).toContain('Sign in again');
  expect(said).not.toContain('STEP_UP_REQUIRED');
});
