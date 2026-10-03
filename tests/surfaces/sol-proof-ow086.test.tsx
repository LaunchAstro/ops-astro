// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount, settle, type Mounted } from './mount.tsx';

let page: Mounted | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
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
