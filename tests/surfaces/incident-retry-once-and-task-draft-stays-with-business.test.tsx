// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable no-await-in-loop -- the proof polls until the real request settles
/* oxlint-disable max-lines-per-function -- Sol's proof, kept as written */
import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { RecordIncident } from '../../apps/web/src/screens/operations/record-incident.tsx';
import { draftApp, draftTab, draftReply, commands } from '../web/projects-draft-app-support.tsx';
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let page: Mounted | undefined;
let harness: Harness | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
  await harness?.close();
  harness = undefined;
});

// Sol OW-086.2 criterion 5, retitled by what it proves; its body is Sol's.
it('retrying an incident after a committed response is lost records it once', async () => {
  harness = await createHarness('sol_ow086_retry');
  const world = harness.world;
  const requests: Record<string, unknown>[] = [];
  const statuses: number[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const response = await world.api.request(String(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${world.ada.token}` },
      body: String(init?.body),
    });
    statuses.push(response.status);
    // The actual transaction has committed. Lose only its first response.
    if (requests.length === 1) throw new TypeError('Response lost after commit');
    return response;
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  let recorded = 0;
  page = await mount(
    <RecordIncident
      client={client}
      onRecorded={() => {
        recorded += 1;
      }}
    />,
  );
  await page.type('[data-field="whatHappened"] textarea', 'Sol OW086 duplicate incident canary');
  await page.type('[data-field="foundAt"] input', new Date(Date.now() - 3600000).toISOString());
  await page.type('[data-field="foundBy"] input', 'Ada');
  await page.type('[data-field="affected"] textarea', 'One client');
  await page.click('[data-kind="contact"] [role="checkbox"]');
  const count = async () => {
    const rows = await world.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.privacy_incidents where business_id = $1',
      [world.alpha],
    );
    return rows[0]?.n;
  };
  const waitForAnswer = async (n: number) => {
    for (let i = 0; i < 200; i += 1) {
      await settle();
      if (statuses.length === n && !page?.find('button[type="submit"]')?.hasAttribute('disabled'))
        return;
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
      });
    }
    throw new Error('The incident did not settle');
  };
  await page.click('button[type="submit"]');
  await waitForAnswer(1);
  expect(statuses).toEqual([200]);
  expect(await count()).toBe(1);
  expect(page.text()).toContain('Response lost after commit');
  await page.click('button[type="submit"]');
  await waitForAnswer(2);
  expect(statuses).toEqual([200, 200]);
  expect(recorded).toBe(1);
  expect(requests).toHaveLength(2);
  expect(await count(), 'Retry must replay the committed incident, not insert a second one').toBe(
    1,
  );
});

// The former inline creator is gone; exercise the shared drawer and its actual App owner switch.
it('business to business switching cannot carry a confidential new-task draft into the other business', async () => {
  const storage = draftTab();
  storage.removeItem('ops-astro.session');
  storage.setItem(
    'ops-astro.return-to',
    JSON.stringify({
      address: '/projects/',
      businessKey: 'bravo',
      code: 'AUTH_SESSION_EXPIRED',
    }),
  );
  const app = await draftApp({
    storage,
    path: '/sign-in',
    reply: (request) => {
      if (request.path.startsWith('http://gotrue.test/token'))
        return Promise.resolve(Response.json({ access_token: 'test-provider-token' }));
      if (request.path === '/api/session')
        return Promise.resolve(Response.json({ session: 'test-tab' }));
      if (request.path === '/session/capabilities')
        return Promise.resolve(Response.json({ ok: true, grants: [] }));
      return Promise.resolve(draftReply(request));
    },
  });
  page = app.view;
  await page.type('#signin-email', 'draft-entry@example.test');
  await page.type('#signin-password', 'test-password');
  await page.choose('#signin-business', 'alpha');
  await page.click('form.signin__form button[type="submit"]');
  await settle();
  await page.click('[data-projects-new-task]');
  await settle();
  await page.type('#panel-draft-name', 'Confidential Alpha client task');
  expect(page.find('#panel-draft-name')).toHaveProperty('value', 'Confidential Alpha client task');
  await page.click('[data-switch="held-address"]');
  await settle();
  expect(page.text()).not.toContain('Confidential Alpha client task');
  await page.click('[data-projects-new-task]');
  await settle();
  expect(page.find('#panel-draft-name')).toHaveProperty('value', '');
  await page.click('[data-draft="create"]');
  await settle();
  expect(commands(app.sent)).toEqual([]);
});
