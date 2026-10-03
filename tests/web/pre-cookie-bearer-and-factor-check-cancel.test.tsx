// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- Sol's proof, kept as written */

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { CSRF_HEADER, SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { json, open, settle, storage } from './mp-2-1-support.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const views: Mounted[] = [];
afterEach(async () => {
  await Promise.all(views.splice(0).map((view) => view.unmount()));
});

// Sol OW-073.1 criterion 3, retitled by what it proves; its body is Sol's.
it('reloading a pre-cookie session removes its script-readable bearer', () => {
  const bearer = 'ops-astro-test-only-legacy-bearer';
  const tab = storage({
    'ops-astro.session': JSON.stringify({
      token: bearer,
      businessKey: 'alpha',
      email: 'mia@alpha.local',
    }),
  });
  // Exactly the persisted format at 1c51169, read by main.tsx on reload.
  const restored = new SessionStore(tab.like);
  expect(JSON.stringify({ memory: restored.session, persisted: [...tab.held] })).not.toContain(
    bearer,
  );
});

function verificationNotRequested(): never {
  throw new Error('verification was not requested');
}

async function checkingMoneyChange() {
  const writes: { readonly session: string | null; readonly limit: unknown }[] = [];
  let finishVerification: (response: Response) => void = verificationNotRequested;
  let verified = false;
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    const headers = new Headers(init?.headers);
    if (path.endsWith('/account/factor/verify')) {
      expect(headers.get(CSRF_HEADER)).toBe('1');
      expect(headers.get(SESSION_HEADER)).toBe('sid-old');
      verified = true;
      return await new Promise<Response>((resolve) => {
        finishVerification = resolve;
      });
    }
    if (path === '/api/session') return json({ ok: true, session: 'sid-new' });
    if (path === '/api/session/end') return json({ ok: true });
    if (path.endsWith('/budget/set_planning_cap')) {
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      const session = headers.get(SESSION_HEADER);
      writes.push({ session, limit: body['limitMinor'] });
      return session === 'sid-new'
        ? json({ recordId: null, revision: null, detail: { state: 'applied' } })
        : json({ refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] }, 403);
    }
    if (path.endsWith('/settings/read')) {
      return json({
        ok: true,
        settings: [],
        planningCap: { limitMinor: 5000, currency: 'AUD', set: false },
      });
    }
    if (path.endsWith('/session/capabilities')) {
      return json({
        ok: true,
        personId: 'p-mia',
        businessKey: 'alpha',
        grants: [{ collection: 'billing', action: 'decide' }],
      });
    }
    if (path.endsWith('/session/person')) return json({ person: { name: 'Mia' } });
    return await new Promise<Response>(() => {});
  };
  const opened = await open('/settings', {
    fetch: fetcher,
    seed: {
      'ops-astro.session': JSON.stringify({
        businessKey: 'alpha',
        email: 'mia@alpha.local',
        sessionId: 'sid-old',
      }),
    },
  });
  views.push(opened.view);
  await settle();
  await opened.view.type('#settings-planning-cap', '75');
  await opened.view.click('[data-settings="save-planning-cap"]');
  await settle();
  await opened.view.type('[data-step-up="code"]', '123456');
  await opened.view.click('[data-step-up="confirm"]');
  expect(verified).toBe(true);
  expect(writes).toEqual([{ session: 'sid-old', limit: 7500 }]);
  const finish = async () => {
    await act(() => {
      finishVerification(json({ accessToken: 'ops-astro-test-only-aal2-token' }));
    });
    await settle();
  };
  return { ...opened, writes, finish };
}

// Sol OW-073.2 control for criterion 4, its title as Sol wrote it; its body is Sol's.
it('control: accepting the delayed code resends the money change on the adopted session', async () => {
  const { writes, finish, sessions } = await checkingMoneyChange();
  await finish();
  expect(sessions.session?.sessionId).toBe('sid-new');
  expect(writes).toEqual([
    { session: 'sid-old', limit: 7500 },
    { session: 'sid-new', limit: 7500 },
  ]);
});

// Sol OW-073.2 criterion 4, retitled by what it proves; its body is Sol's.
it('cancelling while a factor check is in flight prevents the money resend', async () => {
  const { view, writes, finish } = await checkingMoneyChange();
  const cancel = view.host.querySelector<HTMLButtonElement>('[data-step-up="cancel"]');
  expect(cancel?.disabled).toBe(false);
  await view.click('[data-step-up="cancel"]');
  expect(view.find('[data-step-up="prompt"]')).toBeNull();
  await finish();
  expect(writes).toEqual([{ session: 'sid-old', limit: 7500 }]);
});
