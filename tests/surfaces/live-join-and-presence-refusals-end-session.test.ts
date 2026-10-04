// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- Sol's proof, kept as written */
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

// Sol OW-082.1 criterion 1, retitled by what it proves; its body is Sol's.
it('a live join refused for an expired session ends the tab session', async () => {
  const ended: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    sessionId: '0123456789abcdef0123456789abcdef',
    fetch: async () =>
      Response.json(
        { refused: true, code: 'AUTH_SESSION_EXPIRED', names: [], fixes: ['Sign in again.'] },
        { status: 401 },
      ),
    onSessionEnded: (refusal) => {
      ended.push(refusal.code);
    },
  });
  expect(await client.openLive(['board'], new AbortController().signal)).toBeNull();
  expect(ended).toEqual(['AUTH_SESSION_EXPIRED']);
});

// Sol OW-082.1 criterion 1, retitled by what it proves; its body is Sol's.
it('a presence call refused after access ended ends the tab session', async () => {
  const ended: string[] = [];
  let revoked = false;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    sessionId: '0123456789abcdef0123456789abcdef',
    fetch: async () =>
      revoked
        ? Response.json(
            { refused: true, code: 'AUTH_NO_MEMBERSHIP', names: [], fixes: [] },
            { status: 403 },
          )
        : Response.json({ ok: true, person: { name: 'Ada' } }),
    onSessionEnded: (refusal) => {
      ended.push(refusal.code);
    },
  });
  expect(await client.read('session.person', {})).toMatchObject({ ok: true });
  revoked = true;
  expect(await client.live('presence?seat=own-seat&topic=task%3Aown-task', {})).toBeNull();
  expect(ended).toEqual(['AUTH_NO_MEMBERSHIP']);
});

// Sol OW-082.1 criterion 1, retitled by what it proves; its body is Sol's.
it('the ordinary read control reports the same expired-session refusal', async () => {
  const ended: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async () =>
      Response.json(
        { refused: true, code: 'AUTH_SESSION_EXPIRED', names: [], fixes: [] },
        { status: 401 },
      ),
    onSessionEnded: (refusal) => {
      ended.push(refusal.code);
    },
  });
  expect(await client.read('session.person', {})).toMatchObject({ refused: true });
  expect(ended).toEqual(['AUTH_SESSION_EXPIRED']);
});
