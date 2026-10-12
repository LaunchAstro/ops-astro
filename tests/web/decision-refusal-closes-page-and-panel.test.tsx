// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A decision refused for want of the grant, in either the task page's Agent
// pane or the dock panel's Agent side, closes the gate's controls in both
// views of the same task. Sol's proof, kept as written and named by behaviour.
/* oxlint-disable max-lines-per-function, require-await, unicorn/consistent-function-scoping -- Sol's proof, kept as written */
import { expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { lineage, version } from '../surfaces/mp-6-1-agent-fixtures.tsx';
import { mount } from '../surfaces/mount.tsx';
import { task, tick } from './task-page-stub.tsx';

const PAGE = '#perspective-panel-agent';
const PANEL = '#panel-perspective-panel-agent';

it.each([
  { from: 'panel', source: PANEL, other: PAGE },
  { from: 'page', source: PAGE, other: PANEL },
])('a refusal in the $from closes both views of the task', async ({ source, other }) => {
  window.sessionStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1700 });
  window.sessionStorage.setItem(
    'ops-astro.session',
    JSON.stringify({ token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' }),
  );
  let decisions = 0;
  const fetch: typeof globalThis.fetch = async (url) => {
    const at = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (at.endsWith('/task/read'))
      return json({
        ok: true,
        task: task({
          proposals: [
            lineage({
              versions: [
                version({
                  gate: {
                    id: 'g-1',
                    state: 'pending',
                    round: 1,
                    expiresAt: null,
                    expired: false,
                    payloadDigest: 'digest',
                  },
                }),
              ],
            }),
          ],
        }),
      });
    if (at.endsWith('/task/decide')) {
      decisions += 1;
      return json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
    }
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
    if (at.endsWith('/task/board')) return json({ ok: true, tasks: [] });
    if (at.endsWith('/preference/read')) return json({ ok: true, preferences: {} });
    if (at.endsWith('/client/list')) return json({ ok: true, clients: [] });
    return json({ ok: false });
  };
  const view = await mount(
    <App
      path="/task/Proj-Verity-Pacing"
      navigate={() => {}}
      sessions={new SessionStore(window.sessionStorage)}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={fetch}
      storage={window.sessionStorage}
    />,
  );
  await tick();
  await view.click('#perspective-panel-team [data-panel-door="log"]');
  await tick();
  await view.click('#panel-perspective-tab-agent');
  await view.click('#perspective-tab-agent');
  await tick();
  expect(view.find(`${PAGE} [data-gate-action="approve"]`)).not.toBeNull();
  expect(view.find(`${PANEL} [data-gate-action="approve"]`)).not.toBeNull();
  await view.click(`${source} [data-gate-action="approve"]`);
  await tick();
  expect(decisions).toBe(1);
  expect(view.find(`${source} [data-gate="closed"]`)).not.toBeNull();
  expect(
    view.find(`${other} [data-gate-action="approve"]`),
    'the same refused authority must close the other view too',
  ).toBeNull();
});
