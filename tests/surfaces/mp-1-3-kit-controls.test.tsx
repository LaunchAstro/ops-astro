// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3, part one: the component gallery page and the kit's controls.
//
// Each test is named after the supporting checklist line it proves. The
// controls are driven the way a person drives them (a click, a key), and the
// sheet is read for the rules the catalogue rules on: one focus ring (DR-1),
// the outline disabled primary (DR-22), the segmented control's hover (SHELL
// I8). The visual match and the three-width captures run on MP-1-7's harness
// over the gallery, which asks for a session: they wait on T4b1's fixture.

import { act, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import {
  Button,
  Checkbox,
  Disclosure,
  HeadButton,
  IconButton,
  SearchBox,
  Segmented,
  Select,
  Switch,
  TextField,
} from '../../packages/ui/src/kit/controls.tsx';
import { GALLERY, Gallery } from '../../packages/ui/src/kit/gallery.tsx';
import { PAGES, pageAt } from '../../apps/web/src/manifest.ts';
import { ROUTES } from '../../apps/web/src/routes.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { mount, type Mounted } from './mount.tsx';
import { primitiveSheets } from '../support/primitive-sheets.ts';

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

const key = async (element: Element | null, name: string): Promise<void> => {
  await act(() => {
    element?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  });
};

it('MP-1-3 the component gallery page is registered and draws the kit', async () => {
  // Read as a plain record, so this test compiles before the route exists.
  expect((ROUTES as Readonly<Record<string, unknown>>)['agency:gallery']).toEqual({
    namespace: 'agency',
    path: '/gallery/',
    title: 'Component gallery',
    surface: 'none',
    authenticated: true,
  });
  // No rail entry: the rail and the tab rows are read off the route manifest
  // (MP-2-1), and the manifest has no page at the gallery's address.
  expect(PAGES.filter((page) => page.path === '/gallery/')).toEqual([]);
  expect(pageAt('/gallery/')).toBeNull();
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

it('MP-1-3 fields: text input, textarea, select menu and search', async () => {
  let title = '';
  mounted = await mount(
    <TextField
      label="Task title"
      value=""
      onChange={(v) => {
        title = v;
      }}
      error="A title needs at least three words"
    />,
  );
  const input = mounted.find('input');
  const label = mounted.find('label');
  expect(label?.getAttribute('for')).toBe(input?.id);
  expect(input?.getAttribute('aria-invalid')).toBe('true');
  expect(mounted.find(`#${String(input?.getAttribute('aria-describedby'))}`)?.textContent).toBe(
    'A title needs at least three words',
  );
  await mounted.type('input', 'Write the brief');
  expect(title).toBe('Write the brief');
  await mounted.unmount();

  mounted = await mount(<TextField label="Brief" value="" onChange={() => {}} multiline />);
  expect(mounted.find('textarea.ta')).not.toBeNull();
  await mounted.unmount();

  let assignee = 'lead';
  const options = [
    { value: 'none', label: 'Unassigned' },
    { value: 'lead', label: 'Account lead' },
    { value: 'designer', label: 'Designer' },
  ];
  mounted = await mount(
    <Select
      label="Assignee"
      options={options}
      value={assignee}
      onChange={(v) => {
        assignee = v;
      }}
    />,
  );
  const trigger = mounted.find('button.sel__btn');
  expect(trigger?.getAttribute('aria-haspopup')).toBe('listbox');
  expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  expect(mounted.find('[role="listbox"]')).toBeNull();
  await key(trigger, 'ArrowDown');
  expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  expect(mounted.all('[role="option"]').map((o) => o.getAttribute('aria-selected'))).toEqual([
    'false',
    'true',
    'false',
  ]);
  await key(trigger, 'ArrowDown');
  expect(trigger?.getAttribute('aria-activedescendant')).toMatch(/-opt-2$/u);
  await key(trigger, 'Enter');
  expect(assignee).toBe('designer');
  expect(mounted.find('[role="listbox"]')).toBeNull();
  await mounted.click('button.sel__btn');
  await key(trigger, 'Escape');
  expect(mounted.find('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await mounted.click('button.sel__btn');
  await mounted.click('[role="option"]:first-child');
  expect(assignee).toBe('none');
  await mounted.unmount();

  mounted = await mount(
    <SearchBox
      label="Search tasks"
      value=""
      onChange={() => {}}
      placeholder="Search"
      keycap="⌘K"
    />,
  );
  expect(mounted.find('input[type="search"]')?.getAttribute('aria-label')).toBe('Search tasks');
  expect(mounted.find('kbd.keycap')?.textContent).toBe('⌘K');
  expect(mounted.find('svg.icon')).not.toBeNull();
  // DS-PRIM-19: the option menu is an accent-bordered box on paper.
  expect(rule('.menu')).toMatch(/border:\s*1px solid var\(--accent\)/u);
  expect(rule('.tf,\n.ta')).toMatch(/border:\s*1px solid var\(--border\)/u);
  expect(sheet).toMatch(/\[aria-invalid='true'\][^{]*\{[^}]*border-color:\s*var\(--danger\)/u);
});

it('MP-1-3 checkbox, switch and disclosure', async () => {
  let checked = false;
  mounted = await mount(
    <Checkbox
      label="Done"
      checked={false}
      onChange={(v) => {
        checked = v;
      }}
    />,
  );
  expect(mounted.find('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false');
  await mounted.click('[role="checkbox"]');
  expect(checked).toBe(true);
  await mounted.unmount();
  // Checked is an outline and a tick, never a fill.
  expect(rule(".check[aria-checked='true']")).toMatch(/border-color:\s*var\(--accent\)/u);
  expect(rule(".check[aria-checked='true']")).not.toMatch(/background/u);

  let on = false;
  mounted = await mount(
    <Switch
      label="Email me"
      on={false}
      onChange={(v) => {
        on = v;
      }}
    />,
  );
  await mounted.click('[role="switch"]');
  expect(on).toBe(true);
  await mounted.unmount();
  const off = renderToStaticMarkup(
    <Switch label="Email me" on={false} onChange={() => {}} disabled reason="Not built yet" />,
  );
  expect(off).toContain('disabled=""');
  expect(off).toContain('title="Not built yet"');
  expect(rule('.switch:disabled')).toMatch(/border-style:\s*dashed/u);

  let open = false;
  mounted = await mount(
    <Disclosure
      label="Show the detail"
      open={false}
      controls="detail"
      onToggle={(v) => {
        open = v;
      }}
    />,
  );
  expect(mounted.find('button')?.getAttribute('aria-expanded')).toBe('false');
  expect(mounted.find('button')?.getAttribute('aria-controls')).toBe('detail');
  await mounted.click('button');
  expect(open).toBe(true);
  expect(rule(".disclosure[aria-expanded='true'] .icon")).toMatch(/rotate\(90deg\)/u);
});

it.todo(
  "MP-1-3 visual match and the gallery captured at three widths in both themes, hover, focus and the open select (MP-1-7 harness; waits on T4b1's signed-in fixture, the gallery asks for a session)",
);
