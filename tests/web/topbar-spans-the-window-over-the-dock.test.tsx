// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// #1230: the dark top bar runs the full width of the window at all times, and
// an open side panel sits below it, as the mockup's does (its app.css, "THE TOP
// BAR IS FIXED"). The strip lived in the content column's chrome, so a seated
// panel, the grid's third track, narrowed the column and the strip with it:
// the panel's track above its 45px start showed the page's white ground. Above
// 900 the strip is now fixed from the rail's edge to the window's, the chrome
// reserves its height, and the dock starts at the same height. jsdom draws no
// layout, so the cascade is read from the sheets, as the other frame tests do.

import { readFileSync } from 'node:fs';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../apps/web/src/App.tsx';
import type { PanelRegistry } from '../../apps/web/src/panels.ts';
import { SessionStore, type StorageLike } from '../../apps/web/src/session/token.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';
import { granted } from './mp-2-1-support.tsx';

const SHEET = ['3-shell.css', '3-dock.css']
  .map((sheet) => readFileSync(`packages/ui/src/styles/${sheet}`, 'utf8'))
  .join('\n');

/** The bodies of every `@media not all and (max-width: 900px)` block: the wide layout. */
function wideBlocks(): string {
  const opener = '@media not all and (max-width: 900px) {';
  const bodies: string[] = [];
  for (let at = SHEET.indexOf(opener); at >= 0; at = SHEET.indexOf(opener, at + 1)) {
    let depth = 0;
    let end = at + opener.length - 1;
    for (; end < SHEET.length; end += 1) {
      if (SHEET[end] === '{') depth += 1;
      if (SHEET[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    bodies.push(SHEET.slice(at + opener.length, end));
  }
  return bodies.join('\n');
}

/** The declarations of every rule whose selector is exactly `selector`, in order. */
function declarations(css: string, selector: string): string {
  const pattern = new RegExp(
    `(?:^|[}\\s])${selector.replaceAll('.', '\\.')}\\s*\\{([^}]*)\\}`,
    'gu',
  );
  return [...css.matchAll(pattern)].map((match) => match[1]).join(';');
}

const SESSION = { token: 'tok', businessKey: 'alpha', email: 'mia@alpha.local' };
const REGISTRY: PanelRegistry = {
  todos: { label: 'Projects', ariaLabel: 'Projects', route: 'agency:projects-board' },
};

function memory(): StorageLike {
  const held = new Map([['ops-astro.session', JSON.stringify(SESSION)]]);
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
    removeItem: (key) => {
      held.delete(key);
    },
  };
}

let page: Mounted | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

describe('#1230 the top bar spans the window while a side panel is open', () => {
  it('above 900 the strip is fixed from the rail to the window edge, on its dark ground', () => {
    const wide = wideBlocks();
    const strip = declarations(wide, '.appbar');
    expect(strip).toMatch(/position:\s*fixed/u);
    expect(strip).toMatch(/top:\s*0[;\s]/u);
    expect(strip).toMatch(/left:\s*var\(--rail-w\)/u);
    expect(strip).toMatch(/right:\s*0[;\s]/u);
    // The strip's ground is the dark chrome on every face and width.
    expect(declarations(SHEET, '.appbar')).toMatch(/background:\s*var\(--app-chrome\)/u);
  });

  it('the chrome reserves the strip, and the dock starts below it at the same height', () => {
    expect(declarations(wideBlocks(), '.chrome')).toMatch(/padding-top:\s*var\(--app-strip\)/u);
    expect(declarations(SHEET, '.dock')).toMatch(/top:\s*var\(--app-strip\)/u);
    expect(declarations(SHEET, '.shell')).toMatch(/--app-strip:\s*45px/u);
  });

  it('with a panel seated, the strip stays mounted in the chrome, outside the dock', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2400 });
    const storage = memory();
    page = await mount(
      <App
        path="/projects/"
        navigate={() => {}}
        sessions={new SessionStore(storage)}
        gotrueUrl="http://gotrue.test"
        apiOrigin=""
        fetch={(() => new Promise<Response>(() => {})) as typeof globalThis.fetch}
        storage={storage as Storage}
        panels={REGISTRY}
        clientAccess={granted}
      />,
    );
    await act(() => {
      page
        ?.find('.dock__tab[data-panel="todos"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const shell = page.find('.shell') as HTMLElement;
    expect(shell.dataset['dock']).toBe('seated');
    expect(page.all('.dpanel')).toHaveLength(1);
    const strip = page.find('.appbar');
    expect(strip?.parentElement?.classList.contains('chrome')).toBe(true);
    expect(strip?.closest('.dock')).toBeNull();
  });
});
