// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/settings` reads the server's values.
//
// The screen no longer has to say "these values cannot be read back". There is
// a read now — `settings.read`, `POST /api/b/:businessKey/settings/read`, body
// `{}`, `settings:read` — and this file holds the four things that follow from
// having one.
//
//  - **The value on the screen is the server's**, with the instant the server
//    last wrote it, and the browser's own memory of its last write is gone from
//    the places where the server now answers.
//  - **The honest states survive.** Loading is loading, a refusal is drawn as a
//    refusal in the server's own words, an absent API is `unavailable` and not
//    a denial, and a business holding no rows yet is empty. None of the four
//    draws a number, because a number drawn in any of them would be one nobody
//    asked the server for (B7).
//  - **The old "last confirmed by this browser" line is the fallback and only
//    the fallback.** When the read is refused or absent, the browser's own
//    confirmed write is all there is, and the screen says exactly that. When
//    the read answers, that line is not on the page at all: two numbers with
//    two provenances, one of them stale, is the ambiguity the read removes.
//  - **A write is followed by a reread.** What lands in the box afterwards is
//    the row as the server holds it, not the command's echo and not the typed
//    number.

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
  json({ refused: true, code, names: [], fixes: ['ask a holder who may delegate'] }, status);

/** One row of `settings.read`, in the shape the API pins. */
const row = (
  key: string,
  value: unknown,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  key,
  value,
  valueType: typeof value === 'boolean' ? 'boolean' : 'number',
  updatedAt: '2026-09-23T02:15:00.000Z',
  updatedByActorId: 'actor-ada',
  ...extra,
});

interface Stub {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: { at: string; body: Record<string, unknown> }[];
}

/**
 * The API as this lane's interfaces pin it, with the two knobs the cases turn:
 * what `settings.read` answers, and what the rows say.
 */
function server(
  options: {
    readonly settings?: () => Response;
    readonly grants?: readonly { collection: string; action: string }[];
  } = {},
): Stub {
  const sent: { at: string; body: Record<string, unknown> }[] = [];
  const grants = options.grants ?? [{ collection: 'settings', action: 'manage' }];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push({ at, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    if (at.endsWith('/session/capabilities')) {
      return json({ ok: true, personId: 'p-ada', businessKey: 'alpha', grants });
    }
    if (at.endsWith('/settings/read')) {
      return (
        options.settings ??
        (() =>
          json({
            ok: true,
            settings: [row('four_eyes_threshold', 500), row('client_sign_off_required', false)],
          }))
      )();
    }
    if (at.endsWith('/settings/set_four_eyes_threshold')) {
      return json({
        recordId: 'row-four-eyes',
        revision: null,
        detail: { key: 'four_eyes_threshold', value: 1200 },
      });
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

const readsOf = (stub: Stub): number =>
  stub.sent.filter((call) => call.at.endsWith('/settings/read')).length;

describe('the settings screen reads the server', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('asks settings.read on open, with an empty body and no operation identity', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    const read = api.sent.find((call) => call.at.endsWith('/settings/read'));
    expect(read).toBeDefined();
    expect(read?.at).toContain('/b/alpha/settings/read');
    // A read has no attempt to be idempotent about and no revision to be stale
    // against, and the client's own `read` is what enforces that.
    expect(read?.body).toEqual({});
    await page.unmount();
  });

  it('draws the server value and when the server last wrote it', async () => {
    const api = server();
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('ready');
    expect(page.find('[data-settings="four-eyes-value"]')?.textContent).toContain('500');
    expect(page.find('[data-settings="four-eyes-updated"]')?.textContent).toContain('2026-09-23');
    expect(page.find('[data-settings="sign-off-value"]')?.textContent).toContain('off');
    // The browser's own memory is not a second answer beside the server's.
    expect(page.find('[data-settings="four-eyes-known"]')).toBeNull();
    expect(page.find('[data-settings="not-readable"]')).toBeNull();
    await page.unmount();
  });

  it('rereads after a write and shows what the row then holds', async () => {
    let value: unknown = 500;
    const api = server({
      settings: () => json({ ok: true, settings: [row('four_eyes_threshold', value)] }),
    });
    const page = await mount(screen(api.fetch));
    await tick();
    expect(readsOf(api)).toBe(1);

    await page.type('#settings-four-eyes', '1200');
    value = 1200;
    await page.click('[data-settings="save-four-eyes"]');
    await tick();

    expect(readsOf(api)).toBe(2);
    expect(page.find('[data-settings="four-eyes-value"]')?.textContent).toContain('1200');
    await page.unmount();
  });

  it('says nothing about an actor the server sent as null', async () => {
    // The live read answers `updatedByActorId: null` for a row the seed wrote,
    // and `null` is a real answer: nobody, or nobody recorded. Printing it is
    // the screen inventing an actor called "null" — the same defect as drawing
    // a default, one field along.
    const api = server({
      settings: () =>
        json({
          ok: true,
          settings: [
            {
              key: 'four_eyes_threshold',
              value: 500,
              valueType: 'numeric',
              updatedAt: '2026-09-23T02:48:24.326Z',
              updatedByActorId: null,
            },
          ],
        }),
    });
    const page = await mount(screen(api.fetch));
    await tick();

    const line = page.find('[data-settings="four-eyes-updated"]')?.textContent ?? '';
    expect(line).toContain('2026-09-23');
    expect(line).not.toContain('null');
    expect(line).not.toContain('by ');
    await page.unmount();
  });

  it('draws a refused read verbatim and falls back to what this browser confirmed', async () => {
    const api = server({ settings: () => refusal('SCOPE_NOT_GRANTED', 403) });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('denied');
    expect(page.find('[data-settings="read"]')?.textContent).toContain('SCOPE_NOT_GRANTED');
    // No number is invented in a state where nobody answered.
    expect(page.find('[data-settings="four-eyes-value"]')).toBeNull();
    // The fallback, and it says where its number would come from.
    expect(page.find('[data-settings="not-readable"]')).not.toBeNull();
    expect(page.find('[data-settings="four-eyes-known"]')?.textContent).toContain('not known');
    await page.unmount();
  });

  it('calls an API that has no such read unavailable, not denied', async () => {
    const api = server({ settings: () => json({ error: 'not found' }, 404) });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('unavailable');
    expect(page.find('[data-settings="read"]')?.textContent).toContain('404');
    expect(page.find('[data-settings="four-eyes-value"]')).toBeNull();
    expect(page.find('[data-settings="not-readable"]')).not.toBeNull();
    await page.unmount();
  });

  it('draws a business that holds no settings rows as empty, with no numbers', async () => {
    const api = server({ settings: () => json({ ok: true, settings: [] }) });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-settings="read"]')?.getAttribute('data-outcome')).toBe('empty');
    expect(page.find('[data-settings="four-eyes-value"]')).toBeNull();
    // Empty is not the shipped default drawn quietly.
    expect(page.text()).not.toContain('500');
    await page.unmount();
  });
});
