// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { SignIn } from '../../apps/web/src/screens/SignIn.tsx';
import { mount, settle } from '../surfaces/mount.tsx';

// Sol F2-FIX2 criterion 3, retitled by what it proves; its body is Sol's.
it.each(['served', 'unavailable'])(
  'a departed sign-in cannot adopt a late %s probe answer',
  // eslint-disable-next-line max-lines-per-function -- one test, its body kept byte for byte
  async (answer) => {
    let release!: (response: Response) => void;
    const probe = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const sent: string[] = [];
    const opened: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      sent.push(`${url} ${new Headers(init?.headers).get('x-ops-astro-session') ?? '-'}`);
      if (url.includes('/token?')) return Response.json({ access_token: 'password-token' });
      if (url === '/api/session') return Response.json({ session: 'abandoned' });
      if (url.endsWith('/session/person')) return await probe;
      return Response.json({ ok: true });
    };
    const view = await mount(
      <SignIn
        gotrueUrl="http://identity.invalid"
        apiOrigin=""
        fetch={fetch}
        ended={null}
        build={null}
        onSignedIn={(session) => {
          opened.push(session);
        }}
      />,
    );
    await view.type('#signin-email', 'ada@example.test');
    await view.type('#signin-password', 'password');
    await view.click('button[type="submit"]');
    await settle();
    expect(sent).toContain('/api/b/alpha/session/person abandoned');
    await view.unmount();
    await act(async () => {
      release(
        answer === 'served'
          ? Response.json({ person: { name: 'Ada' } })
          : new Response(null, { status: 503 }),
      );
      await probe;
    });
    await settle();
    expect({
      opened,
      revoked: sent.includes('/api/b/alpha/account/sessions/sign-out abandoned'),
      cookieEnded: sent.includes('/api/session/end abandoned'),
    }).toEqual({
      opened: [],
      revoked: true,
      cookieEnded: true,
    });
  },
);
