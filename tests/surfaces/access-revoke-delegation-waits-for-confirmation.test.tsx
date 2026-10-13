// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Revoke delegation is confirmed before anything is sent, as ending access
// and revoking a grant already are.

import { expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { access, ADA, MIA, json } from './access-screen-world.tsx';
import { mount, settle } from './mount.tsx';

it('Revoke delegation waits for confirmation before sending', async () => {
  const sent: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (input) => {
      const path = String(input);
      if (path.endsWith('/access/read')) return Promise.resolve(json(access([ADA, MIA])));
      sent.push(path);
      return Promise.resolve(json({ recordId: 'r', revision: 1 }));
    },
  });
  const view = await mount(<AccessScreen client={client} grantKey="alpha:ada:0" />);
  await settle();
  await settle();
  await view.click('[data-revoke="d-1"] button');
  await settle();
  expect(sent, 'the first press must ask for confirmation without revoking').toEqual([]);
});
