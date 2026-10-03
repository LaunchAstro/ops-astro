// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function, unicorn/prefer-dom-node-dataset -- Sol's proof body, committed unchanged */
/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Shell } from '../../packages/ui/src/surfaces/Shell.tsx';
import type { DockProps } from '../../packages/ui/src/surfaces/Dock.tsx';
import { launchChromium } from '../support/chromium.ts';
import { clampSheet, dockGeometry } from '../../apps/web/src/dock/geometry.ts';
import { dockTabs } from '../../apps/web/src/panels.ts';

// Read the shipped CSS order, including the application's final overrides.
const css =
  [...readFileSync('packages/ui/src/index.ts', 'utf8').matchAll(/import '\.\/styles\/([^']+)';/gu)]
    .map((match) => readFileSync(`packages/ui/src/styles/${match[1]}`, 'utf8'))
    .join('\n') + readFileSync('apps/web/src/styles/6-slice.css', 'utf8');
const noop = () => {};

// Sol OW-126 correctness, retitled by what it proves; its body is Sol's.
it('six available sheet panels at the permitted minimum keep every close control clickable', async () => {
  const ids = ['ai', 'notifs', 'team', 'clients', 'todos', 'settings'];
  expect(dockTabs().map((tab) => tab.id)).toEqual(ids.slice(1));
  expect(
    dockGeometry({
      viewport: 1100,
      navRail: 224,
      width: 550,
      open: ['ai', 'notifs', 'team', 'clients', 'todos', 'settings'],
    }).open,
  ).toEqual(ids);
  expect(clampSheet(220, 1000)).toBe(220);
  const dock: DockProps = {
    tabs: ids.map((id) => ({ id, label: id, count: null, open: true })),
    panels: ids.map((id) => ({
      id,
      label: id,
      ariaLabel: id,
      door: '/',
      canBack: false,
      canForward: false,
      body: <p>Panel contents</p>,
    })),
    layout: { mode: 'sheet', panelWidth: 0, sheetHeight: 220, sheetMax: 860 },
    onTab: noop,
    onClose: noop,
    onCloseAll: noop,
    onBack: noop,
    onForward: noop,
    onDoor: noop,
  };
  const markup = renderToStaticMarkup(
    <Shell
      face="agency"
      rail={[]}
      here="/"
      title="Board"
      build={null}
      dock={dock}
      dockSheetHeight={220}
    >
      <p>Page contents</p>
    </Shell>,
  );
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    await page.setContent(`<style>${css}</style>${markup}`);
    const boxes = await page.locator('.dpanel').evaluateAll((panels) =>
      panels.map((panel) => {
        const frame = panel.getBoundingClientRect();
        const closeElement = panel.querySelector('.dpanel__x');
        const close = closeElement?.getBoundingClientRect();
        const hit =
          close === undefined
            ? null
            : document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2);
        return {
          id: panel.getAttribute('data-panel-id'),
          panelTop: frame.top,
          panelBottom: frame.bottom,
          closeTop: close?.top,
          closeBottom: close?.bottom,
          clickable: closeElement !== null && hit !== null && closeElement.contains(hit),
          hit: hit?.outerHTML,
        };
      }),
    );
    expect(boxes).toHaveLength(6);
    for (const box of boxes) {
      expect(box.clickable, JSON.stringify(box)).toBe(true);
    }
  } finally {
    await browser.close();
  }
});
