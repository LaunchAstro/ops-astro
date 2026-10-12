// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { mount } from '../surfaces/mount.tsx';

/* eslint-disable max-lines-per-function, require-await -- Sol's proof, kept as written */
// Sol's proof on #1371 (round 2), retitled by what it proves; its body is Sol's.
it('availability saves use the refreshed sign-in under the same grant key', async () => {
  const sessionsSent: (string | null)[] = [];
  let refreshed = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const at = String(input);
    if (at.endsWith('/team/list'))
      return Response.json({
        ok: true,
        you: 'p-me',
        people: [
          { personId: 'p-me', name: 'Ada Admin', availability: null },
          { personId: 'p-bo', name: 'Bo Reader', availability: null },
        ],
      });
    if (at.endsWith('/account/availability')) {
      const session = new Headers(init?.headers).get(SESSION_HEADER);
      sessionsSent.push(session);
      if (refreshed && session === 'old-sign-in')
        return Response.json(
          {
            refused: true,
            code: 'AUTH_SESSION_EXPIRED',
            names: [],
            fixes: ['Sign in again.'],
          },
          { status: 401 },
        );
      return Response.json({ availability: { state: 'away', reason: 'At the dentist' } });
    }
    return Response.json({}, { status: 404 });
  };
  const client = (sessionId: string) =>
    new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      sessionId,
      fetch,
    });
  const view = await mount(
    <TeamScreen client={client('old-sign-in')} grantKey="alpha:ada@example.test:0" />,
  );
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.find('.tmc__strip')).not.toBeNull();
    refreshed = true;
    await view.render(
      <TeamScreen client={client('new-sign-in')} grantKey="alpha:ada@example.test:0" />,
    );
    await view.click('.tmc__me button.tmc__set');
    await view.type('.tmc__me input[name="reason"]', 'At the dentist');
    await view.click('.tmc__me button[type="submit"]');
    await act(async () => {
      await Promise.resolve();
    });
    expect(sessionsSent).toEqual(['new-sign-in']);
    expect(view.text()).not.toContain('Sign in again.');
  } finally {
    await view.unmount();
  }
});
/* eslint-enable max-lines-per-function, require-await */
