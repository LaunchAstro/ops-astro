// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop, max-lines-per-function, unicorn/consistent-function-scoping -- Sol's proof, kept as written */
import { afterEach, expect, it } from 'vitest';
import { SESSION_HEADER } from '../../packages/core-wire/src/index.ts';
import { json, open, settle } from './mp-2-1-support.tsx';
import { ADA } from '../surfaces/access-screen-world.tsx';
import type { Mounted } from '../surfaces/mount.tsx';

const live: Mounted[] = [];
afterEach(async () => {
  for (const view of live.splice(0)) await view.unmount();
});

const seed = {
  'ops-astro.session': JSON.stringify({
    businessKey: 'alpha',
    email: 'ada@alpha.local',
    sessionId: 'sid-old',
  }),
};

it('Sol proof, criterion 5: cancelling during verification prevents the held money write from being resent', async () => {
  let answer: (response: Response) => void = () => {};
  const verifying = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  const writes: { session: string | null; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/account/factor/verify')) return await verifying;
    if (url === '/api/session') return json({ ok: true, session: 'sid-new' });
    if (url.endsWith('/budget/set_planning_cap')) {
      const session = new Headers(init?.headers).get(SESSION_HEADER);
      writes.push({ session, body: JSON.parse(String(init?.body)) });
      return session === 'sid-new'
        ? json({ recordId: null, revision: null, detail: {} })
        : json({ refused: true, code: 'STEP_UP_REQUIRED', names: [], fixes: [] }, 403);
    }
    if (url.endsWith('/settings/read'))
      return json({
        ok: true,
        settings: [],
        planningCap: { limitMinor: 5000, currency: 'AUD', set: false },
      });
    if (url.endsWith('/session/capabilities'))
      return json({
        ok: true,
        personId: ADA.personId,
        businessKey: 'alpha',
        grants: [{ collection: 'billing', action: 'decide' }],
      });
    if (url.endsWith('/account/sessions/list')) return json({ sessions: [] });
    if (url.endsWith('/session/person')) return json({ person: { name: ADA.name } });
    return json({ ok: true });
  };
  const { view } = await open('/settings', { fetch, seed });
  live.push(view);
  await settle();
  await view.type('#settings-planning-cap', '75');
  await view.click('[data-settings="save-planning-cap"]');
  await settle();
  expect(writes).toHaveLength(1);
  await view.type('[data-step-up="code"]', '123456');
  await view.click('[data-step-up="confirm"]');
  expect(view.find('[data-step-up="confirm"]')?.textContent).toContain('Checking');
  await view.click('[data-step-up="cancel"]');
  expect(view.find('[data-step-up="prompt"]')).toBeNull();
  answer(json({ accessToken: 'sol-test-aal2-token' }));
  await settle();
  expect(
    writes,
    'Cancel must withdraw the held budget change even when verification later succeeds',
  ).toHaveLength(1);
});
