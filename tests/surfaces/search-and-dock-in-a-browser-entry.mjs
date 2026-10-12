// SPDX-License-Identifier: AGPL-3.0-only
// The page the browser check drives. Sol's, kept as written.
/* oxlint-disable unicorn/prefer-query-selector, require-await, unicorn/no-useless-undefined -- Sol's check page, kept as written */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@launchastro/ui';
import '../../apps/web/src/styles/6-slice.css';
import { App } from '../../apps/web/src/App.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { Dock } from '../../packages/ui/src/surfaces/Dock.tsx';

const h = React.createElement;
let root = createRoot(document.getElementById('root'));
const json = (body) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const task = {
  id: '33333333-3333-4333-8333-333333333333',
  key: 'TSK-1',
  title: 'Browser proof task',
  description: null,
  agentBrief: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 1,
  history: [],
  comments: [],
  proposals: [],
};
const fetch = async (url) => {
  const at = String(url);
  if (at.endsWith('/task/read')) return json({ ok: true, task });
  if (at.endsWith('/task/queue')) return json({ ok: true, queue: [], alerts: [], outages: [] });
  if (at.endsWith('/task/board'))
    return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] });
  if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
  if (at.endsWith('/preference/read')) return json({ ok: true, preferences: {} });
  if (at.endsWith('/client/list')) return json({ ok: true, clients: [] });
  return json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] });
};
window.paintApp = () => {
  sessionStorage.clear();
  sessionStorage.setItem(
    'ops-astro.session',
    JSON.stringify({ token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' }),
  );
  root.render(
    h(App, {
      path: '/task/TSK-1',
      navigate() {},
      sessions: new SessionStore(sessionStorage),
      storage: sessionStorage,
      gotrueUrl: 'http://identity.invalid',
      apiOrigin: '',
      fetch,
    }),
  );
};
function ScrollProbe() {
  const [stage, setStage] = useState('long');
  const [walk, setWalk] = useState(0);
  const [saved, setSaved] = useState(undefined);
  window.away = () => {
    setSaved(document.querySelector('.dpanel__body').scrollTop);
    setStage('away');
  };
  window.back = () => {
    setStage('loading');
    setWalk((last) => last + 1);
  };
  window.resolveRead = () => setStage('long');
  return h(Dock, {
    tabs: [],
    layout: { mode: 'floating', panelWidth: 550 },
    restoreWalk: walk,
    onTab() {},
    onClose() {},
    onCloseAll() {},
    onBack: window.back,
    onForward() {},
    onDoor() {},
    panels:
      stage === 'away'
        ? []
        : [
            {
              id: 'todos',
              label: 'Projects',
              ariaLabel: 'Projects',
              door: '/projects/',
              canBack: true,
              canForward: false,
              scrollTop: saved,
              body:
                stage === 'loading'
                  ? h('p', null, 'Loading')
                  : h(
                      'ul',
                      null,
                      Array.from({ length: 80 }, (_, at) =>
                        h('li', { key: at, style: { height: 30 } }, `Row ${at}`),
                      ),
                    ),
            },
          ],
  });
}
window.paintScroll = () => {
  root.unmount();
  root = createRoot(document.getElementById('root'));
  root.render(h(ScrollProbe));
};
window.ready = true;
