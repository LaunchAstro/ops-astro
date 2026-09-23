// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings`: the two business settings the model classifies `operation`, and
// the honest shape of a screen whose values the API will not read back.
//
// **There is no settings read in this build.** `COMMAND_SURFACE` declares four
// reads — `task.read`, `task.board`, `person.list`, `preset.plan` — and none of
// them carries `business_settings`. So this screen cannot open on the stored
// value, and it does not pretend to: it says so in as many words, and the
// numbers it draws are the last write *this browser* had confirmed by the
// server's own `detail` echo, labelled as exactly that.
//
// That is the difference between an unknown value and a default. A screen that
// opened showing `500` because `500` is the shipped default would be telling a
// person their business's threshold, having never asked anybody.
//
// The three rules held here:
//
//  - Unknown is drawn as unknown, and the missing read is named on the screen.
//  - A write goes out through the command that owns the row, carries an
//    `operationId` and no `expectedRevision`, and what comes back is the
//    server's own echo rather than the number that was typed.
//  - A refused write changes nothing on the screen and closes the control.

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

/** The two settings commands, answering the way the API does. */
function server(options: { readonly refuse?: boolean } = {}) {
  const sent: { readonly at: string; readonly body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    sent.push({ at, body });
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
      // `business_settings` carries no revision, so the outcome has none. The
      // detail is the row's key and the value it now holds, which is the only
      // thing in this build that tells a caller what a setting was set to.
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
  new OperationsClient({ base: '/api', businessKey: 'alpha', token: 'tok', fetch });

const screen = (fetch: typeof globalThis.fetch) => (
  <SettingsScreen client={client(fetch)} grantKey="alpha:ada" storage={window.sessionStorage} />
);

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

  it('says the values are not readable, and names the read that is missing', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    const said = page.find('[data-settings="not-readable"]');
    expect(said).not.toBeNull();
    expect(said?.textContent).toContain('settings');
    // The unknown value is drawn as unknown. Not as the shipped default, which
    // would be this screen telling a person something nobody asked the server.
    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('not known');
    // Nothing was read, because there is nothing to read with.
    expect(api.sent).toHaveLength(0);
    await page.unmount();
  });

  it('writes the threshold through the command that owns it and echoes the server', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    await typeInto(page.host, '#settings-four-eyes', '1200');
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.at).toContain('/b/alpha/settings/set_four_eyes_threshold');
    expect(api.sent[0]?.body['value']).toBe(1200);
    expect(typeof api.sent[0]?.body['operationId']).toBe('string');
    // No revision is sent: the row has none to be stale against.
    expect('expectedRevision' in (api.sent[0]?.body ?? {})).toBe(false);

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

    expect(api.sent[0]?.body['value']).toBeNull();
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

    expect(api.sent[0]?.at).toContain('/settings/set_client_sign_off');
    expect(api.sent[0]?.body['value']).toBe(true);
    await page.unmount();
  });

  it('keeps the last confirmed write across a remount, still labelled as unread', async () => {
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
    // Still not a read. The screen says where the number came from.
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
    expect(api.sent).toHaveLength(1);
    await page.unmount();
  });
});
