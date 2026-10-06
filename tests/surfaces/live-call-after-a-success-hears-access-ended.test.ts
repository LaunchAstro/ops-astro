// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

// Sol F1-FIX2 criterion 3, retitled by what it proves; its body is Sol's.
it('a live call refused for access ended after a live success ends the session', async () => {
  const ended: string[] = [];
  let revoked = false;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    sessionId: 'sid-own',
    fetch: () =>
      Promise.resolve(
        revoked
          ? Response.json(
              { refused: true, code: 'AUTH_ACCESS_ENDED', names: [], fixes: [] },
              { status: 403 },
            )
          : Response.json({ present: true }),
      ),
    onSessionEnded: (refusal) => ended.push(refusal.code),
  });
  expect(await client.live('presence?seat=own-seat&topic=task%3Aown-task', {})).toEqual({
    present: true,
  });
  revoked = true;
  expect(await client.live('presence?seat=own-seat&topic=task%3Aown-task', {})).toBeNull();
  expect(ended, 'A live call hears access ended as a read does.').toEqual(['AUTH_ACCESS_ENDED']);
});
