// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Lost writes on the graduation region keep their own operation and draft
// (#1427): two lost writes are each retried under their own operation, and a
// lost filing's draft never goes out under another business or person.

import type { ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { ConnectionsScreen } from '../../apps/web/src/screens/Connections.tsx';
import { mount } from './mount.tsx';
import {
  fill,
  filings,
  opens,
  regionOn,
  stubServer,
  tick,
  unmountOpened,
  valueOf,
} from './graduation-draft-server.tsx';

afterEach(unmountOpened);

it('two lost writes each keep their own operation, retried in either order', async () => {
  const stub = stubServer({ loseAfter: ['/mandate/file'], loseBefore: ['/mandate/revoke'] });
  const page = await regionOn(stub);
  await fill(page);
  await page.click('[data-mandate-add]');
  await tick();
  await page.click('[data-mandate="m-seed"] [data-mandate-revoke]');
  await page.click('[data-confirm="revoke-mandate"] [data-act="revoke"] button');
  await tick();
  await page.click('[data-mandate="m-seed"] [data-mandate-revoke]');
  await page.click('[data-confirm="revoke-mandate"] [data-act="revoke"] button');
  await tick();
  await page.click('[data-mandate-add]');
  await tick();
  const revokes = stub.sent.filter((one) => one.at.endsWith('/mandate/revoke'));
  const [lost, again] = filings(stub);
  expect(revokes.map((one) => one.body['operationId'])).toStrictEqual([
    revokes[0]?.body['operationId'],
    revokes[0]?.body['operationId'],
  ]);
  expect([again?.['operationId'], again?.['draftId']]).toStrictEqual([
    lost?.['operationId'],
    lost?.['draftId'],
  ]);
  expect(stub.held().filter((one) => one.label === 'Approve posts')).toHaveLength(1);
});

it('a lost filing’s draft is never sent under another business or person', async () => {
  const stub = stubServer({ loseAfter: ['/mandate/file'] });
  const screen = (businessKey: string, grantKey: string): ReactElement => (
    <ConnectionsScreen
      client={new OperationsClient({ origin: '', businessKey, signedIn: true, fetch: stub.fetch })}
      grantKey={grantKey}
      now={() => Date.parse('2026-10-12T00:00:00Z')}
    />
  );
  const page = opens(await mount(screen('alpha', 'alpha:a@x:0')));
  await tick();
  await fill(page);
  await page.click('[data-mandate-add]');
  await tick();
  for (const [business, grant] of [
    ['bravo', 'bravo:a@x:0'],
    ['alpha', 'alpha:b@x:0'],
  ] as const) {
    // eslint-disable-next-line no-await-in-loop -- one switch at a time
    await page.render(screen(business, grant));
    // eslint-disable-next-line no-await-in-loop -- let the region read
    await tick();
    expect(valueOf(page, '[data-mandate-label]'), grant).toBe('');
    // eslint-disable-next-line no-await-in-loop -- one filing per switch
    await fill(page);
    // eslint-disable-next-line no-await-in-loop -- one filing per switch
    await page.click('[data-mandate-add]');
    // eslint-disable-next-line no-await-in-loop -- let the answer land
    await tick();
  }
  const [lost, ...after] = filings(stub);
  expect(after).toHaveLength(2);
  for (const one of after) {
    expect(one['draftId']).not.toBe(lost?.['draftId']);
    expect(one['operationId']).not.toBe(lost?.['operationId']);
  }
  expect(new Set(after.map((one) => one['draftId'])).size).toBe(2);
});
