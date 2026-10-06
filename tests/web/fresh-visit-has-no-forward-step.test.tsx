// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable unicorn/prefer-single-call -- Sol's proof, kept as written */
import { expect, it } from 'vitest';
import { Root } from '../../apps/web/src/root.tsx';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { TabHistory } from '../../apps/web/src/tab-history.ts';
import { mount } from '../surfaces/mount.tsx';
import { layout } from './frame-support.tsx';
import { silent } from './mp-2-1-support.tsx';

// Sol OW-082.2 criterion correctness, retitled by what it proves; its body is Sol's.
it('a fresh visit at the newest history entry has no Forward step', async () => {
  const undo = layout();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/dashboard/');
  const previous = new TabHistory(window);
  previous.push('/projects/');
  previous.push('/settings');
  // A document navigation to a typed address adds a new entry with null state,
  // retaining this tab's sessionStorage. It is now the newest entry.
  window.history.pushState(null, '', '/dashboard/');
  const sessions = new SessionStore(null);
  sessions.set({ businessKey: 'alpha', email: 'ada@example.test' });
  const view = await mount(
    <Root
      window={window}
      sessions={sessions}
      storage={null}
      gotrueUrl="http://identity.invalid"
      apiOrigin=""
      fetch={silent}
    />,
  );
  try {
    const forward = view.find('.appbar button[aria-label="Forward"]');
    expect(forward).not.toBeNull();
    expect(forward?.getAttribute('disabled')).not.toBeNull();
  } finally {
    await view.unmount();
    window.sessionStorage.clear();
    undo();
  }
});
