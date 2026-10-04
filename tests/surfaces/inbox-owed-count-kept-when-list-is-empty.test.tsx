// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable require-await -- Sol's proof, kept as written */
//
// Catalogue #520: inbox.read and inbox.count are two requests, so an item
// raised between them can leave an empty list beside a positive owed count.
// The count is the server's word; the page keeps it rather than saying
// nothing is waiting. Sol's OW-112 criterion 5 proof, body as written.

import { afterEach, expect, it } from 'vitest';
import { InboxScreen } from '../../apps/web/src/screens/Inbox.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

it('an item raised between inbox reads does not erase the authoritative owed count', async () => {
  const calls: string[] = [];
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      // Valid consecutive snapshots: inbox.read finishes, an assignment is
      // raised, then the separate inbox.count request sees one owed item.
      const body = path.endsWith('/inbox/read')
        ? { ok: true, inbox: [] }
        : path.endsWith('/inbox/count')
          ? { ok: true, owed: 1 }
          : null;
      return new Response(JSON.stringify(body), {
        status: body === null ? 503 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  view = await mount(<InboxScreen client={client} grantKey="alpha:mia" navigate={() => {}} />);
  await settle();
  await settle();
  expect(calls.filter((path) => path.includes('/inbox/'))).toEqual([
    '/api/b/alpha/inbox/read',
    '/api/b/alpha/inbox/count',
  ]);
  expect(view.find('.nt__sum b')?.textContent, 'inbox.count returned one; the page hides it').toBe(
    '1',
  );
});
