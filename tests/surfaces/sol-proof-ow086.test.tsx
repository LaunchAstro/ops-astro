// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// oxlint-disable no-await-in-loop -- the proof polls until the real request settles
import { afterEach, expect, it } from 'vitest';
import { act } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { RecordIncident } from '../../apps/web/src/screens/operations/record-incident.tsx';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
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

it('Sol proof, criterion 5: retrying an incident after a committed response is lost records it once', async () => {
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

it('Sol proof, criterion 2: business to business switching cannot carry a confidential new-task draft into the other business', async () => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const at = String(url);
    if (at.includes('/live?')) return Promise.resolve(new Response(null, { status: 503 }));
    if (at.endsWith('/task/create')) {
      writes.push({ url: at, body: JSON.parse(String(init?.body)) });
    }
    const body = at.endsWith('/task/board')
      ? { ok: true, tasks: [], withheld: 0 }
      : at.endsWith('/person/list')
        ? { ok: true, persons: [] }
        : at.endsWith('/inbox/read')
          ? { ok: true, inbox: [] }
          : at.endsWith('/inbox/count')
            ? { ok: true, owed: 0 }
            : { recordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: 1, detail: {} };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  const client = (businessKey: string) =>
    new OperationsClient({ origin: '', businessKey, signedIn: true, fetch });
  page = await mount(
    <Projects client={client('alpha')} grantKey="alpha:ada" navigate={() => {}} />,
  );
  await page.type('#create-title', 'Confidential Alpha client task');
  expect((page.find('#create-title') as HTMLInputElement).value).toBe(
    'Confidential Alpha client task',
  );
  await page.render(<Projects client={client('bravo')} grantKey="bravo:ada" navigate={() => {}} />);
  await settle();
  await page.click('button[type="submit"]');
  await settle();
  expect(
    writes.filter(
      (write) =>
        write.url.includes('/b/bravo/') &&
        JSON.stringify(write.body).includes('Confidential Alpha client task'),
    ),
    'The Alpha draft must not become a Bravo task',
  ).toEqual([]);
});
