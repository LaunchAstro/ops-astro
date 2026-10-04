// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- Sol's proof, kept as written */
import { StrictMode, useState, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { mount } from '../surfaces/mount.tsx';
import { json, settle, storage } from './mp-2-1-support.tsx';

// Sol PR-345.1 criterion 1, retitled by what it proves; its body is Sol's.
it('the browser entry StrictMode completes a good first code and drops the secret', async () => {
  const store = storage();
  const sessions = new SessionStore(store.like);
  sessions.set({ businessKey: 'alpha', email: 'mia@alpha.local', sessionId: 'sid-old' });
  const sent: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    sent.push(url);
    if (url.endsWith('/account/factor/enrol')) {
      return json({
        factorId: 'factor-one',
        qrCode: 'data:image/svg+xml,<svg/>',
        secret: 'SOL-SECRET',
        uri: 'otpauth://totp/test',
      });
    }
    if (url.endsWith('/account/factor/verify')) return json({ accessToken: 'sol-aal2' });
    if (url === '/api/session') return json({ ok: true, session: 'sid-new' });
    if (url === '/api/session/end') return json({ ok: true });
    if (url.endsWith('/account/sessions/list')) return json({ sessions: [] });
    if (url.endsWith('/settings/read'))
      return json({
        ok: true,
        settings: [],
        planningCap: { limitMinor: 5000, currency: 'AUD', set: false },
      });
    if (url.endsWith('/session/capabilities'))
      return json({ ok: true, personId: 'p-mia', businessKey: 'alpha', grants: [] });
    if (url.endsWith('/session/person')) return json({ person: { name: 'Mia Hart' } });
    return await new Promise<Response>(() => {});
  };
  function Harness(): ReactElement {
    const [path, navigate] = useState('/settings');
    return (
      <StrictMode>
        <App
          path={path}
          navigate={navigate}
          sessions={sessions}
          gotrueUrl="http://identity.invalid"
          apiOrigin=""
          fetch={fetcher}
          storage={null}
        />
      </StrictMode>
    );
  }
  const view = await mount(<Harness />);
  try {
    await settle();
    await view.click('[data-factor="enrol"] button');
    await settle();
    expect(view.find('[data-factor="secret"]')?.textContent).toBe('SOL-SECRET');
    await view.type('[data-factor="panel"] [data-step-up="code"]', '123456');
    await view.click('[data-factor="confirm"] button');
    await settle();
    expect(sent.filter((url) => url.endsWith('/account/factor/verify'))).toHaveLength(1);
    expect(sent.filter((url) => url === '/api/session')).toHaveLength(1);
    expect(sessions.session?.sessionId).toBe('sid-new');
    // The real step-up finished; StrictMode's effect replay must not leave
    // the confirmation stuck in Checking with the secret still visible.
    expect(view.find('[data-factor="done"]')).not.toBeNull();
    expect(view.text()).not.toContain('SOL-SECRET');
  } finally {
    await view.unmount();
  }
});
