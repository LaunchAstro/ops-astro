// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-3-5 through the application: back and forward on every head, disabled
// but never hidden; the inventory's driven sequence (walk a panel, back
// returns the panel to where it was and keeps it open, forward returns the
// walk); history lives in memory only and belongs to one person in one
// business. Every read stays in flight: only the dock is under test.

import { afterEach, describe, expect, it } from 'vitest';
import { act, type ReactElement } from 'react';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { press } from '../../apps/web/src/dock/open-set.ts';
import { useDock } from '../../apps/web/src/dock/use-dock.ts';
import { SessionStore, type Session, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

const SESSION = { sessionId: 'sid', businessKey: 'alpha', email: 'mia@alpha.local' };
const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
  settings: { label: 'Settings', ariaLabel: 'Business settings', route: 'agency:settings' },
};

function memory(): StorageLike & { readonly held: Map<string, string> } {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    held,
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

const live: Mounted[] = [];
afterEach(async () => {
  for (const page of live.splice(0)) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await page.unmount();
  }
});

async function at(storage: StorageLike = memory()): Promise<Mounted> {
  const page = await mount(
    <App
      path="/settings"
      navigate={() => {}}
      sessions={new SessionStore(storage)}
      gotrueUrl="http://gotrue.test"
      apiOrigin=""
      fetch={(() => new Promise<Response>(() => {})) as typeof globalThis.fetch}
      storage={storage as Storage}
      panels={REGISTRY}
    />,
  );
  live.push(page);
  return page;
}

async function clickOn(target: Element | null, shiftKey = false): Promise<void> {
  if (target === null) throw new Error('no target');
  await act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  });
}

const tab = (page: Mounted, id: string): Element | null =>
  page.find(`.dock__tab[data-panel="${id}"]`);
const openIds = (page: Mounted): (string | undefined)[] =>
  page.all('.dpanel').map((each) => (each as HTMLElement).dataset['panelId']);
const doorOf = (page: Mounted, id: string): string | null =>
  page.find(`[data-panel-id="${id}"] [data-act="door"]`)?.getAttribute('href') ?? null;
const disabled = (page: Mounted, way: 'back' | 'forward'): (string | null)[] =>
  page.all(`[data-act="${way}"]`).map((each) => each.getAttribute('aria-disabled'));

async function walk(page: Mounted, id: string, href: string): Promise<void> {
  const link = document.createElement('a');
  link.setAttribute('href', href);
  (page.find(`[data-panel-id="${id}"] .dpanel__body`) as HTMLElement).append(link);
  await clickOn(link);
}

describe('MP-3-5 back and forward on every head', () => {
  it('draws both on every open head, disabled but never hidden, enabled once there is a way', async () => {
    const page = await at();
    await clickOn(tab(page, 'todos'));
    await clickOn(tab(page, 'settings'), true);
    expect(disabled(page, 'back')).toEqual(['false', 'false']);
    expect(disabled(page, 'forward')).toEqual(['true', 'true']);
    await clickOn(page.find('[data-panel-id="todos"] [data-act="back"]'));
    expect(openIds(page)).toEqual(['todos']);
    expect(disabled(page, 'forward')).toEqual(['false']);
  });
});

describe('MP-3-5 driven sequence', () => {
  it('walk, back to where the panel was with it still open, forward to the walk', async () => {
    const page = await at();
    await clickOn(tab(page, 'todos'));
    await walk(page, 'todos', '/task/T-1');
    expect(doorOf(page, 'todos')).toBe('/task/T-1');
    await clickOn(page.find('[data-panel-id="todos"] [data-act="back"]'));
    expect(openIds(page)).toEqual(['todos']);
    expect(doorOf(page, 'todos')).toBe('/projects/');
    await clickOn(page.find('[data-panel-id="todos"] [data-act="forward"]'));
    expect(doorOf(page, 'todos')).toBe('/task/T-1');
  });

  it('back after a close brings the closed panel back where it was', async () => {
    const page = await at();
    await clickOn(tab(page, 'todos'));
    await walk(page, 'todos', '/task/T-1');
    await clickOn(tab(page, 'settings'), true);
    await clickOn(page.find('[data-panel-id="todos"] .dpanel__x'));
    expect(openIds(page)).toEqual(['settings']);
    await clickOn(page.find('[data-panel-id="settings"] [data-act="back"]'));
    expect(openIds(page)).toEqual(['todos', 'settings']);
    expect(doorOf(page, 'todos')).toBe('/task/T-1');
  });

  it('restores each panel scroll with its entry', async () => {
    const page = await at();
    await clickOn(tab(page, 'todos'));
    const body = page.find('[data-panel-id="todos"] .dpanel__body') as HTMLElement;
    body.scrollTop = 180;
    await act(() => {
      body.dispatchEvent(new Event('scroll'));
    });
    await walk(page, 'todos', '/task/T-1');
    (page.find('[data-panel-id="todos"] .dpanel__body') as HTMLElement).scrollTop = 0;
    await clickOn(page.find('[data-panel-id="todos"] [data-act="back"]'));
    expect((page.find('[data-panel-id="todos"] .dpanel__body') as HTMLElement).scrollTop).toBe(180);
  });
});

describe('MP-3-5 memory only', () => {
  it('keeps no history in the tab: a reload starts with both ways disabled', async () => {
    const storage = memory();
    const page = await at(storage);
    await clickOn(tab(page, 'todos'));
    await walk(page, 'todos', '/task/T-1');
    expect([...storage.held.keys()].toSorted()).toEqual([
      'ops-astro.dock.alpha',
      'ops-astro.session',
    ]);
    const reloaded = await at(storage);
    expect(openIds(reloaded)).toEqual(['todos']);
    expect(disabled(reloaded, 'back')).toEqual(['true']);
    expect(disabled(reloaded, 'forward')).toEqual(['true']);
  });
});

describe('MP-3-5 one person in one business', () => {
  function Harness(props: {
    readonly session: Session;
    readonly storage: StorageLike;
  }): ReactElement {
    const dock = useDock(props.session, props.storage, REGISTRY);
    return (
      <div>
        <button
          type="button"
          data-open
          onClick={() => {
            dock.change((state) => press(state, 'todos', false));
          }}
        />
        <output data-can-back={String(dock.history.canBack)} />
      </div>
    );
  }

  it('starts a new history for another business and for another person', async () => {
    const storage = memory();
    const page = await mount(<Harness session={SESSION} storage={storage} />);
    live.push(page);
    await page.click('[data-open]');
    expect((page.find('output') as HTMLElement | null)?.dataset['canBack']).toBe('true');
    await page.render(<Harness session={{ ...SESSION, businessKey: 'bravo' }} storage={storage} />);
    expect((page.find('output') as HTMLElement | null)?.dataset['canBack']).toBe('false');
    await page.render(<Harness session={SESSION} storage={storage} />);
    await page.click('[data-open]');
    await page.render(
      <Harness
        session={{ ...SESSION, email: 'noah@alpha.local', sessionId: 's2' }}
        storage={storage}
      />,
    );
    expect((page.find('output') as HTMLElement | null)?.dataset['canBack']).toBe('false');
  });
});
