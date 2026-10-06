// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects tab is its address's (MP-8-4): a dock panel's comes from the
// panel's own place, never the page's fragment, and the page's from the page.
// Either follows a later change of that address, and a Work log once drawn
// stays drawn, whichever way it was opened.

import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { FIRST, TAB, drawn, pinZone, server, tick } from './work-log-stand-in.tsx';

pinZone();

const selected = (view: Mounted): string | null | undefined =>
  view.find('[role="tab"][aria-selected="true"]')?.textContent;

/** Projects at an address, in a dock panel or on the page, over one client. */
function at(fetch: typeof globalThis.fetch, inPanel: boolean): (address: string) => ReactElement {
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const draw = (place: string): ReactElement => (
    <Projects
      client={client}
      grantKey="alpha:owner"
      navigate={() => {}}
      address={place}
      inPanel={inPanel}
    />
  );
  return draw;
}

/** The page moving to an address, as the application's own navigation does. */
const go = (address: string): void => {
  window.history.pushState(null, '', address);
};

describe('Projects tab in a dock panel', () => {
  it('opens on its own address’s Work log, and its Board when that address changes', async () => {
    window.history.replaceState(null, '', '/clients/');
    const api = server([{ body: FIRST }]);
    const draw = at(api.fetch, true);
    const view = await mount(draw('/projects/#worklog'));
    await tick();

    expect(selected(view)).toBe('Work log');
    expect(api.asked).toHaveLength(1);
    expect(drawn(view)).toEqual(['e1', 'e2']);

    await view.render(draw('/projects/'));
    await tick();
    expect(selected(view)).toBe('Board');
    expect(window.location.pathname).toBe('/clients/');
    await view.unmount();
  });

  it('the page’s #worklog fragment does not open a panel’s Work log', async () => {
    window.history.replaceState(null, '', '/projects/#worklog');
    const api = server([{ body: FIRST }]);
    const view = await mount(at(api.fetch, true)('/projects/'));
    await tick();

    expect(selected(view)).toBe('Board');
    expect(api.asked).toHaveLength(0);
    await view.unmount();
  });

  it('a Work log its address opened stays drawn when the tab is left and taken again', async () => {
    window.history.replaceState(null, '', '/clients/');
    const api = server([{ body: FIRST }]);
    const draw = at(api.fetch, true);
    const view = await mount(draw('/projects/#worklog'));
    await tick();
    expect(selected(view)).toBe('Work log');

    await view.click(`${TAB}:nth-child(1)`);
    await view.click(`${TAB}:nth-child(2)`);
    await tick();
    expect(selected(view)).toBe('Work log');
    expect(drawn(view)).toEqual(['e1', 'e2']);

    await view.render(draw('/projects/'));
    await view.render(draw('/projects/#worklog'));
    await tick();
    expect(selected(view)).toBe('Work log');
    expect(drawn(view)).toEqual(['e1', 'e2']);
    expect(api.asked).toHaveLength(1);
    await view.unmount();
  });
});

describe('Projects tab on the page', () => {
  it('follows a later navigation between the two Projects addresses', async () => {
    window.history.replaceState(null, '', '/projects/');
    const api = server([{ body: FIRST }]);
    const draw = at(api.fetch, false);
    const view = await mount(draw('/projects/'));
    await tick();
    expect(selected(view)).toBe('Board');

    go('/projects/#worklog');
    await view.render(draw('/projects/#worklog'));
    await tick();
    expect(selected(view)).toBe('Work log');
    expect(drawn(view)).toEqual(['e1', 'e2']);

    go('/projects/');
    await view.render(draw('/projects/'));
    expect(selected(view)).toBe('Board');

    // A tab chosen on the page writes its fragment; a navigation back to the
    // bare address then lands on the Board, the Work log kept drawn.
    await view.click(`${TAB}:nth-child(2)`);
    expect(window.location.hash).toBe('#worklog');
    go('/projects/');
    await view.render(draw('/projects/'));
    expect(selected(view)).toBe('Board');
    expect(api.asked).toHaveLength(1);
    await view.unmount();
  });
});
