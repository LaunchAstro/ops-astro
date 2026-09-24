// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings`: the two business settings the model classifies `operation`, and
// the writes that own them.
//
// The reads this screen opens on have three files of their own —
// `settings-read`, `settings-capabilities` and `settings-revision`. This one
// holds what was true before they existed and is still true after: each setting
// is written through the command that owns it, `null` is a real value and not a
// zero, a refusal is quoted in the server's own words and closes the control,
// and the browser's memory of its own last confirmed write is the fallback for
// the case where nothing answered.
//
// That fallback is the difference between an unknown value and a default. A
// screen that drew `500` because `500` is the shipped default would be telling
// a person their business's threshold, having never asked anybody.

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

/**
 * The API the screen meets.
 *
 * `reads` off is the build that has neither read mounted — the live API at
 * `9970ddc` — so both come back `unavailable` and the screen falls back the way
 * it did before this lane. That is the shape the fallback cases want, and it is
 * a real answer from a real server rather than a case invented for the test.
 */
function server(options: { readonly refuse?: boolean; readonly reads?: boolean } = {}) {
  const sent: { readonly at: string; readonly body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ at, body });
    if (at.endsWith('/settings/read') || at.endsWith('/session/capabilities')) {
      if (options.reads !== true) return json({ error: 'not found' }, 404);
      return at.endsWith('/settings/read')
        ? json({ ok: true, settings: [] })
        : json({
            ok: true,
            personId: 'p-ada',
            businessKey: 'alpha',
            grants: [{ collection: 'settings', action: 'manage' }],
          });
    }
    if (options.refuse === true) {
      return json(
        {
          refused: true,
          code: 'SCOPE_NOT_GRANTED',
          names: [],
          fixes: ['no live grant covers it', 'ask a holder who may delegate'],
        },
        403,
      );
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      // The row carried no revision, so the outcome has none. The detail is the
      // row's key and the value it now holds.
      return json({
        recordId: 'row-four-eyes',
        revision: null,
        detail: { key: 'four_eyes_threshold', value: body['value'] },
      });
    }
    if (at.endsWith('/settings/set_client_sign_off')) {
      return json({
        recordId: 'row-sign-off',
        revision: null,
        detail: { key: 'client_sign_off_required', value: body['value'] },
      });
    }
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const client = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });

const screen = (fetch: typeof globalThis.fetch) => (
  <SettingsScreen client={client(fetch)} grantKey="alpha:ada" storage={window.sessionStorage} />
);

/** Only the writes. The two reads are this file's background, not its subject. */
const writes = (
  api: ReturnType<typeof server>,
): readonly { readonly at: string; readonly body: Record<string, unknown> }[] =>
  api.sent.filter((call) => call.at.includes('/settings/set_'));

async function typeInto(host: HTMLElement, selector: string, value: string): Promise<void> {
  const field = host.querySelector(selector) as HTMLInputElement | null;
  if (field === null) throw new Error(`nothing matches ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the settings screen', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('falls back to this browser, named as such, when neither read answers', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    const said = page.find('[data-settings="not-readable"]');
    expect(said).not.toBeNull();
    expect(said?.textContent).toContain('settings.read');
    // The unknown value is drawn as unknown. Not as the shipped default, which
    // would be this screen telling a person something nobody asked the server.
    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('not known');
    // Both reads were asked for. Neither was answered, and nothing was written.
    expect(api.sent).toHaveLength(2);
    expect(writes(api)).toHaveLength(0);
    await page.unmount();
  });

  it('writes the threshold through the command that owns it and echoes the server', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    await typeInto(page.host, '#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    const sent = writes(api);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.at).toContain('/b/alpha/settings/set_four_eyes_threshold');
    expect(sent[0]?.body['value']).toBe(1200);
    expect(typeof sent[0]?.body['operationId']).toBe('string');
    // No revision is sent: the read carried none, so there is nothing to be
    // stale against.
    expect('expectedRevision' in (sent[0]?.body ?? {})).toBe(false);

    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('1200');
    await page.unmount();
  });

  it('turns the band off with a real null rather than a zero', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    await page.click('#settings-four-eyes-off');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect(writes(api)[0]?.body['value']).toBeNull();
    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('off');
    await page.unmount();
  });

  it('writes client sign-off as a boolean', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    await page.click('#settings-sign-off');
    await page.click('[data-settings="save-sign-off"]');
    await tick();

    expect(writes(api)[0]?.at).toContain('/settings/set_client_sign_off');
    expect(writes(api)[0]?.body['value']).toBe(true);
    await page.unmount();
  });

  it('keeps the last confirmed write across a remount, still labelled as this browser', async () => {
    const api = server();
    const first = await mount(screen(api.fetch));
    await tick();
    await typeInto(first.host, '#settings-four-eyes', '750');
    await first.click('[data-settings="save-four-eyes"]');
    await tick();
    await first.unmount();

    const again = await mount(screen(server().fetch));
    await tick();
    expect(again.find('[data-settings="four-eyes-known"]')?.textContent).toContain('750');
    // Still not the server's word, and the screen still says so.
    expect(again.find('[data-settings="not-readable"]')).not.toBeNull();
    await again.unmount();
  });

  it('draws a refusal verbatim, closes the control and leaves the value alone', async () => {
    const api = server({ refuse: true });
    const page = await mount(screen(api.fetch));
    await tick();

    await typeInto(page.host, '#settings-four-eyes', '99');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect(page.find('[data-settings="refusal"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    expect((page.find('[data-settings="save-four-eyes"]') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((page.find('#settings-four-eyes') as HTMLInputElement).disabled).toBe(true);
    expect((page.find('[data-settings="save-sign-off"]') as HTMLButtonElement).disabled).toBe(true);
    // The refused number was never confirmed, so it never became the known one.
    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('not known');

    // And the closed control does not ask again.
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(writes(api)).toHaveLength(1);
    await page.unmount();
  });

  it('draws a read that answered with no rows as empty, and writes create them', async () => {
    const api = server({ reads: true });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('empty');
    // Empty is not the fallback: nothing answered is a different fact from an
    // answer with nothing in it.
    expect(page.find('[data-settings="not-readable"]')).toBeNull();
    expect(page.find('[data-settings="four-eyes-known"]')).toBeNull();

    await typeInto(page.host, '#settings-four-eyes', '640');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();
    expect(writes(api)).toHaveLength(1);
    await page.unmount();
  });
});
