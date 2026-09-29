// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable unicorn/prefer-dom-node-dataset -- the owner check reads the attribute the markup writes */
//
// C31, the Keys panel: set a key, reload, it shows "set" and no value is on
// the page; clear it and it shows "not set" (the owner check, in the browser's
// half). The server here is a stub that keeps the value it was sent, so the
// case can prove the page never draws it back.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { KeysPanel } from '../../apps/web/src/screens/settings/keys.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const VALUE = 'panel-canary-9f2c-never-drawn';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- let the answers land in turn
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

function server(): { readonly fetch: typeof globalThis.fetch; readonly sent: string[] } {
  const sent: string[] = [];
  let state: 'set' | 'not set' | null = null;
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/secret/list')) {
      return json({
        ok: true,
        secrets:
          state === null
            ? []
            : [
                {
                  id: 's-1',
                  name: 'xero.key',
                  clientId: null,
                  state,
                  setAt: null,
                  lastUsedAt: null,
                  revision: 1,
                },
              ],
      });
    }
    if (at.endsWith('/secret/set')) {
      state = 'set';
      return json({ recordId: 's-1', revision: 1, detail: { secretId: 's-1', state: 'set' } });
    }
    if (at.endsWith('/secret/clear')) {
      state = 'not set';
      return json({ recordId: 's-1', revision: 2, detail: { secretId: 's-1', state: 'not set' } });
    }
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as typeof globalThis.fetch;
  return { fetch, sent };
}

describe('C31 Keys panel', () => {
  it('C31 owner check: set shows "set" with no value drawn; clear shows "not set"', async () => {
    const stub = server();
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      token: 'tok',
      fetch: stub.fetch,
    });
    const page = await mount(<KeysPanel client={client} />);
    await tick();
    await page.type('[data-settings="keys"] input:not([type="password"])', 'xero.key');
    await page.type('[data-settings="key-value"]', VALUE);
    await page.click('[data-settings="keys"] button[type="submit"]');
    await tick();
    expect(stub.sent.some((call) => call.includes('/secret/set') && call.includes(VALUE))).toBe(
      true,
    );
    expect((page.find('[data-settings="key-value"]') as HTMLInputElement).value).toBe('');
    expect(page.find('[data-secret="xero.key"]')?.getAttribute('data-state')).toBe('set');
    expect(page.text()).not.toContain(VALUE);
    expect(page.host.innerHTML).not.toContain(VALUE);

    // A reload is a fresh mount against the same server.
    await page.unmount();
    const again = await mount(<KeysPanel client={client} />);
    await tick();
    expect(again.find('[data-secret="xero.key"]')?.getAttribute('data-state')).toBe('set');
    expect(again.host.innerHTML).not.toContain(VALUE);
    await again.click('[data-secret="xero.key"] button');
    await tick();
    expect(again.find('[data-secret="xero.key"]')?.getAttribute('data-state')).toBe('not set');
    await again.unmount();
  });
});
