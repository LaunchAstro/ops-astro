// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { KeysPanel } from '../../apps/web/src/screens/settings/keys.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

it('Sol proof, criterion 5: a newer custody write denial drops the authorised list while its reread is pending', async () => {
  let reads = 0;
  const held = new Promise<Response>(() => {});
  const fetcher: typeof fetch = (url) => {
    if (String(url).endsWith('/secret/list')) {
      reads += 1;
      if (reads > 1) return held;
      return Promise.resolve(json({ ok: true, canChange: true, secrets: [{
        id: 's-1', name: 'private-client.connection', clientId: 'private-client',
        state: 'set', setAt: null, lastUsedAt: null, revision: 1,
      }] }));
    }
    return Promise.resolve(json({ refused: true, code: 'SCOPE_NOT_GRANTED',
      names: ['custody:manage'], fixes: [] }, 403));
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch: fetcher });
  const page = await mount(<KeysPanel client={client} />);
  try {
    await settle();
    expect(page.find('[data-secret]')).not.toBeNull();
    await page.click('[data-secret] button');
    await settle();
    expect(reads).toBe(2);
    expect(page.text()).toContain('SCOPE_NOT_GRANTED');
    expect(page.find('[data-secret]')).toBeNull();
    expect(page.find('form')).toBeNull();
  } finally {
    await page.unmount();
  }
});
