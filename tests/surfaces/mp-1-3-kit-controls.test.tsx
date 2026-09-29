// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3, part one: the component gallery page and the kit's controls.
//
// Each test is named after the supporting checklist line it proves. The
// controls are driven the way a person drives them (a click, a key), and the
// sheet is read for the rules the catalogue rules on: one focus ring (DR-1),
// the outline disabled primary (DR-22), the segmented control's hover (SHELL
// I8). The visual match draws the gallery in a real browser at three widths in
// both themes (tests/visual/gallery-views.ts, mp-1-3-gallery-states.ts).

import { spawnSync } from 'node:child_process';
import { type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { Button, HeadButton, IconButton, Segmented } from '../../packages/ui/src/kit/controls.tsx';
import { GALLERY, Gallery } from '../../packages/ui/src/kit/gallery.tsx';
import { ROUTES } from '../../apps/web/src/routes.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { mount, type Mounted } from './mount.tsx';
import { primitiveSheets } from '../support/primitive-sheets.ts';
import type { GalleryReport } from './mp-1-3-gallery-states.ts';

// Node's URL, not the document's: jsdom replaces the global one.
const sheet = primitiveSheets();
/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (selector: string): string => {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(sheet)?.[1] ?? '';
};

const html = (element: ReactElement): string => renderToStaticMarkup(element);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('MP-1-3 the component gallery page is registered and draws the kit', async () => {
  // Read as a plain record, so this test compiles before the route exists.
  expect((ROUTES as Readonly<Record<string, unknown>>)['agency:gallery']).toEqual({
    namespace: 'agency',
    path: '/gallery/',
    title: 'Component gallery',
    surface: 'none',
    rail: false,
    authenticated: true,
  });
  expect(typeof (SCREENS as Readonly<Record<string, unknown>>)['agency:gallery']).toBe('function');
  mounted = await mount(<Gallery />);
  const ids = mounted
    .all('[data-catalogue-id]')
    .map((e) => (e as HTMLElement).dataset['catalogueId']);
  expect(ids).toEqual(GALLERY.map((e) => e.id));
  expect(new Set(ids).size).toBe(ids.length);
  for (const entry of GALLERY) {
    const states = mounted.all(`[data-catalogue-id="${entry.id}"] [data-gallery-state]`);
    expect(states.length, entry.id).toBe(entry.states.length);
    expect(states.length, entry.id).toBeGreaterThan(0);
  }
  // Sample words only: the gallery reads no record and names no one.
  expect(mounted.text()).not.toMatch(/@|\b[A-Z][a-z]+ [A-Z][a-z]+son\b/u);
});

it('MP-1-3 button with its variants', () => {
  for (const variant of ['primary', 'secondary', 'ghost', 'text'] as const) {
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(
        html(
          <Button variant={variant} size={size}>
            Go
          </Button>,
        ),
      ).toContain(`class="btn btn--${variant} btn--${size}"`);
    }
  }
  expect(html(<Button>Go</Button>)).toContain('class="btn btn--secondary btn--sm"');
  expect(html(<Button pressed>Mine</Button>)).toContain('aria-pressed="true"');
  const busy = html(<Button busy="Saving…">Save</Button>);
  expect(busy).toContain('aria-busy="true"');
  expect(busy).toContain('disabled=""');
  expect(busy).toContain('>Saving…</button>');
  const reasoned = html(
    <Button variant="primary" disabled reason="Payments are not built yet">
      Pay now
    </Button>,
  );
  expect(reasoned).toContain('title="Payments are not built yet"');
  // DR-22: a disabled primary is an outline with muted text, never a grey fill.
  const primaryDisabled = rule('.btn--primary:disabled');
  expect(primaryDisabled).toMatch(/background:\s*transparent/u);
  expect(primaryDisabled).toMatch(/border-color:\s*var\(--border\)/u);
  expect(primaryDisabled).toMatch(/color:\s*var\(--text-muted\)/u);
  // Secondary inverts to an ink fill on hover; primary hover is the accent.
  expect(rule('.btn--secondary:hover:not(:disabled)')).toMatch(/background:\s*var\(--text\)/u);
  // The mockup's outline strength: full ink on light, on-dark at 55% in dark
  // (--btn-outline); hover brings the border up to the ink it fills with.
  expect(rule('.btn')).toMatch(/border:\s*1px solid var\(--btn-outline\)/u);
  expect(rule('.btn--secondary:hover:not(:disabled)')).toMatch(/border-color:\s*var\(--text\)/u);
  expect(rule('.btn--primary:hover:not(:disabled)')).toMatch(/background:\s*var\(--accent\)/u);
  // DR-1: one focus ring, the global one; no button draws its own outline.
  expect(sheet).not.toMatch(/\.btn[^{]*:focus[^{]*\{[^}]*outline:\s*(?!none)/u);
  expect(rule('.btn--sm')).toMatch(/height:\s*27px/u);
  expect(rule('.btn--md')).toMatch(/height:\s*38px/u);
  expect(rule('.btn--lg')).toMatch(/height:\s*43px/u);
});

it('MP-1-3 dock head button with variants', () => {
  expect(html(<HeadButton kind="close" />)).toContain('aria-label="Close"');
  expect(html(<HeadButton kind="back" />)).toContain('aria-label="Back"');
  expect(html(<HeadButton kind="forward" disabled />)).toContain('disabled=""');
  expect(html(<HeadButton kind="new" label="New task" />)).toContain('aria-label="New task"');
  expect(html(<HeadButton kind="close-all" />)).toContain('aria-label="Close all panels"');
  // Every head button is the one icon button, 26 square.
  for (const kind of ['close', 'back', 'forward', 'new', 'close-all'] as const) {
    expect(html(<HeadButton kind={kind} />)).toMatch(/^<button type="button" class="ibtn"/u);
  }
  expect(
    html(<IconButton icon="pencil" label="Edit" size="compact" tone="danger" reveal />),
  ).toContain('class="ibtn ibtn--compact ibtn--danger ibtn--reveal"');
  expect(rule('.ibtn')).toMatch(/width:\s*26px/u);
  expect(rule('.ibtn--compact')).toMatch(/width:\s*22px/u);
  // DR-24: revealed-on-hover tools show at rest below 900 and on focus.
  expect(sheet).toMatch(/@media \(width <= 900px\)\s*\{\s*\.ibtn--reveal\s*\{\s*opacity:\s*1/u);
  expect(sheet).toMatch(/\.ibtn--reveal:focus-visible[^{]*\{[^}]*opacity:\s*1/u);
});

it('MP-1-3 segmented control with a hover rule', async () => {
  let chosen = '';
  mounted = await mount(
    <Segmented
      label="Show"
      value="open"
      onChange={(v) => {
        chosen = v;
      }}
      options={[
        { value: 'open', label: 'Open' },
        { value: 'done', label: 'Done' },
      ]}
    />,
  );
  expect(mounted.find('[role="group"]')?.getAttribute('aria-label')).toBe('Show');
  const pressed = mounted.all('button').map((b) => b.getAttribute('aria-pressed'));
  expect(pressed).toEqual(['true', 'false']);
  await mounted.click('button:nth-of-type(2)');
  expect(chosen).toBe('done');
  // SHELL I8: every segmented option and every facet has a hover rule.
  expect(rule(".segmented__opt:hover:not([aria-pressed='true'])")).toMatch(
    /color:\s*var\(--text\)/u,
  );
  expect(rule('.facet:hover')).toMatch(/border-color:\s*var\(--border-strong\)/u);
  // A pressed facet is an accent outline, never a fill.
  expect(rule(".facet[aria-pressed='true']")).toMatch(/border-color:\s*var\(--accent\)/u);
  expect(rule(".facet[aria-pressed='true']")).not.toMatch(/background/u);
});

it('MP-1-3 visual match: the gallery at 1480, 900 and 390, light and dark, every entry drawn inside the width, with hover, focus and the open select, in a browser', () => {
  const script = new globalThis.URL('mp-1-3-gallery-states.ts', import.meta.url).pathname;
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 900_000 });
  expect(run.status, run.stderr.slice(-2000)).toBe(0);
  const { views, sameInDark } = JSON.parse(run.stdout) as GalleryReport;
  const ids = GALLERY.map((entry) => entry.id);
  expect(views.map((view) => view.name)).toEqual(
    [1480, 900, 390].flatMap((width) => [`gallery@${width}-light`, `gallery@${width}-dark`]),
  );
  for (const view of views) {
    const width = Number(/@(\d+)-/u.exec(view.name)?.[1]);
    expect(view.sideways, `${view.name} scrolls sideways`).toBe(0);
    expect(view.boxes.map((box) => box.id)).toEqual(ids);
    for (const box of view.boxes) {
      expect(box.width * box.height, `${view.name}: ${box.id} is not drawn`).toBeGreaterThan(0);
      expect(box.left, `${view.name}: ${box.id} starts off the page`).toBeGreaterThanOrEqual(0);
      expect(box.right, `${view.name}: ${box.id} runs past the width`).toBeLessThanOrEqual(width);
    }
    expect(view.hoverDiffers, `${view.name}: hover on the segmented control`).toBe(true);
    expect(view.focusDiffers, `${view.name}: keyboard focus on a button`).toBe(true);
    expect(view.ring, `${view.name}: the focus ring`).not.toBe('none');
    expect(view.select, `${view.name}: the select opens on a click`).toEqual({
      closedMenus: 0,
      openMenus: 1,
    });
  }
  expect(sameInDark, 'entries drawn the same in dark as in light').toEqual([]);
}, 900_000);
