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

interface Stub {
  /** What `secret.set` answers instead of applying; undefined applies it. */
  readonly refuseSet?: () => Response;
  /** The list's `canChange`: the key held business-wide. */
  canChange?: boolean;
}

function server(stub: Stub = {}): {
  readonly fetch: typeof globalThis.fetch;
  readonly sent: string[];
} {
  const sent: string[] = [];
  let state: 'set' | 'not set' | null = null;
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    sent.push(`${at} ${String(init?.body ?? '')}`);
    if (at.endsWith('/secret/list')) {
      return json({
        ok: true,
        canChange: stub.canChange ?? true,
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
      if (stub.refuseSet !== undefined) return stub.refuseSet();
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
      signedIn: true,
      fetch: stub.fetch,
    });
    const page = await mount(<KeysPanel client={client} />);
    await tick();
    await page.type('[data-settings="keys"] #key-name', 'xero.key');
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

const REFUSALS: readonly (readonly [string, () => Response])[] = [
  [
    'a chat session token refused FIELD_VALUE_INVALID',
    () =>
      json(
        { refused: true, code: 'FIELD_VALUE_INVALID', names: ['value'], fixes: ['Not a key.'] },
        422,
      ),
  ],
  [
    'no custody key, DEPENDENCY_NOT_LANDED',
    () =>
      json({ refused: true, code: 'DEPENDENCY_NOT_LANDED', names: ['secret.set'], fixes: [] }, 501),
  ],
  ['a server fault with no body', () => new Response('', { status: 500 })],
];

const clientOf = (fetch: typeof globalThis.fetch): OperationsClient =>
  new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });

const stored = (): string =>
  [localStorage, sessionStorage]
    .flatMap((store) => Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`))
    .join('\n');

describe('C31 Keys panel keeps the value', () => {
  for (const [what, refusal] of REFUSALS) {
    it(`C31 a refused set (${what}) shows a fixed message and never the value`, async () => {
      const stub = server({ refuseSet: refusal });
      const page = await mount(<KeysPanel client={clientOf(stub.fetch)} />);
      await tick();
      await page.type('#key-name', 'xero.key');
      await page.type('[data-settings="key-value"]', VALUE);
      await page.click('[data-settings="keys"] button[type="submit"]');
      await tick();
      expect(page.find('[data-settings="keys-refusal"]')).not.toBeNull();
      expect(page.host.innerHTML).not.toContain(VALUE);
      expect((page.find('[data-settings="key-value"]') as HTMLInputElement).value).toBe('');
      expect(stored()).not.toContain(VALUE);
      await page.unmount();
    });
  }

  it('C31 the value field is no password field: no password manager saves or fills it', async () => {
    const page = await mount(<KeysPanel client={clientOf(server().fetch)} />);
    await tick();
    const field = page.find('[data-settings="key-value"]') as HTMLInputElement;
    expect(field.type).toBe('text');
    expect(page.find('input[type="password"]')).toBeNull();
    expect(field.getAttribute('autocomplete')).toBe('off');
    expect(field.getAttribute('spellcheck')).toBe('false');
    expect(field.getAttribute('autocapitalize')).toBe('off');
    expect(field.getAttribute('autocorrect')).toBe('off');
    expect(field.getAttribute('data-1p-ignore')).not.toBeNull();
    expect(field.getAttribute('data-lpignore')).toBe('true');
    expect(field.className).toContain('tf--sealed');
    await page.unmount();
  });
});

describe('C31 Keys panel field', () => {
  it('C31 a typed value is in no attribute of the page before it is sent', async () => {
    const page = await mount(<KeysPanel client={clientOf(server().fetch)} />);
    await tick();
    await page.type('[data-settings="key-value"]', VALUE);
    const field = page.find('[data-settings="key-value"]') as HTMLInputElement;
    expect(field.getAttribute('value') ?? '').not.toContain(VALUE);
    expect(page.host.innerHTML).not.toContain(VALUE);
    await page.unmount();
  });

  it('C31 the typed value cannot be copied, cut or dragged out of its field', async () => {
    const page = await mount(<KeysPanel client={clientOf(server().fetch)} />);
    await tick();
    const field = page.find('[data-settings="key-value"]') as HTMLInputElement;
    for (const kind of ['copy', 'cut', 'dragstart']) {
      const event = new Event(kind, { bubbles: true, cancelable: true });
      field.dispatchEvent(event);
      expect(event.defaultPrevented, kind).toBe(true);
    }
    await page.unmount();
  });
});

describe('C31 Keys panel offers changes only where allowed', () => {
  it('C31 a holder who may not change keys sees them listed, with no Set form and no Clear', async () => {
    const options: Stub = {};
    const stub = server(options);
    const page = await mount(<KeysPanel client={clientOf(stub.fetch)} />);
    await tick();
    await page.type('#key-name', 'xero.key');
    await page.type('[data-settings="key-value"]', VALUE);
    await page.click('[data-settings="keys"] button[type="submit"]');
    await tick();
    await page.unmount();
    // The same set row, now read by a client-scoped holder.
    options.canChange = false;
    const row = await mount(<KeysPanel client={clientOf(stub.fetch)} />);
    await tick();
    expect(row.find('[data-secret="xero.key"]')?.getAttribute('data-state')).toBe('set');
    expect(row.find('form[aria-label="Set a key"]')).toBeNull();
    expect(row.find('[data-settings="keys"] button')).toBeNull();
    await row.unmount();
  });
});

describe('C31 Keys panel look', () => {
  it('C31 look: the keys draw as a list card of page rows, each state a chip', async () => {
    const stub = server();
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: stub.fetch,
    });
    const page = await mount(<KeysPanel client={client} />);
    await tick();
    await page.type('[data-settings="keys"] #key-name', 'xero.key');
    await page.type('[data-settings="key-value"]', VALUE);
    await page.click('[data-settings="keys"] button[type="submit"]');
    await tick();
    expect(page.find('[data-settings="keys"]')?.className).toBe('card card--flush');
    expect(page.find('[data-settings="keys"] .card__title')?.textContent).toBe('Keys');
    const row = page.find('[data-secret="xero.key"]');
    expect(row?.className).toBe('lrow lrow--page');
    expect(row?.querySelector('.lrow__title')?.textContent).toBe('xero.key');
    expect(row?.querySelector('.lrow__meta')?.textContent).toBe('Whole business · last used never');
    expect(row?.querySelector('.lrow__trail .chip')?.textContent).toBe('Set');
    expect(row?.querySelector('.lrow__trail .btn')?.textContent).toBe('Clear');
    expect(page.find('[data-settings="keys"] form.form')).not.toBeNull();
    await page.unmount();
  });
});
