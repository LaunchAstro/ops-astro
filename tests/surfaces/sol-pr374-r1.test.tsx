// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { KeysPanel } from '../../apps/web/src/screens/settings/keys.tsx';
import { SettingsScreen } from '../../apps/web/src/screens/Settings.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { madeUpAnswer } from '../visual/made-up-api.ts';
import { mount, settle } from './mount.tsx';

const row = {
  id: 's-1',
  name: 'alpha.private-key-name',
  clientId: null,
  state: 'set',
  setAt: null,
  lastUsedAt: null,
  revision: 1,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const listed = () => json({ ok: true, canChange: true, secrets: [row] });
const denied = () =>
  json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: ['custody:manage'], fixes: [] }, 403);
const clientOf = (fetcher: typeof globalThis.fetch) =>
  new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch: fetcher });

it('Sol proof, criterion 5: an older authorised list cannot restore keys after a newer denial', async () => {
  let reads = 0;
  let release = (_response: Response): void => {};
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith('/secret/list')) {
      reads += 1;
      if (reads === 2) return await held;
      return reads === 1 ? listed() : denied();
    }
    return json({ recordId: row.id, revision: 2, detail: {} });
  };
  const page = await mount(<KeysPanel client={clientOf(fetcher)} />);
  try {
    await settle();
    await page.click('[data-secret] button');
    await settle();
    expect(reads).toBe(2);
    await page.click('[data-secret] button');
    await settle();
    expect(reads).toBe(3);
    expect(page.text()).toContain('You are not permitted');
    await act(async () => {
      release(listed());
    });
    expect(page.find('[data-secret]')).toBeNull();
    expect(page.find('form')).toBeNull();
  } finally {
    await page.unmount();
  }
});

it('Sol proof, criterion 1: the width-and-theme Settings harness actually draws its custody keys', async () => {
  const fetcher: typeof fetch = async (url) => {
    const answer = madeUpAnswer(String(url));
    if (answer === undefined || 'pending' in answer) return json({}, 404);
    return json(answer.json, answer.status);
  };
  const page = await mount(
    <SettingsScreen client={clientOf(fetcher)} grantKey="harness-alpha" storage={null} />,
  );
  try {
    await settle();
    expect(page.find('[data-settings="keys"]')).not.toBeNull();
    expect(page.text()).toContain('xero.client-secret');
  } finally {
    await page.unmount();
  }
});
