// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3, the kit's fields and toggles: the text field and textarea, the
// select with its option menu, the search box, the checkbox, the switch and
// the disclosure, each driven by clicks and keys. The rest of the controls
// are in mp-1-3-kit-controls.test.tsx.

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import {
  Checkbox,
  Disclosure,
  SearchBox,
  Select,
  Switch,
  TextField,
} from '../../packages/ui/src/kit/controls.tsx';
import { mount, type Mounted } from './mount.tsx';
import { primitiveSheets } from '../support/primitive-sheets.ts';

// Node's URL, not the document's: jsdom replaces the global one.
const sheet = primitiveSheets();
/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (selector: string): string => {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(sheet)?.[1] ?? '';
};

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

/** The text field and the textarea: label, error, typing. */
async function textFields(): Promise<void> {
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
}

/** The select: its listbox, the arrow keys, Enter, Escape and a click. */
async function selectMenu(): Promise<void> {
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
}

/** The search box, and the field and menu rules the sheet holds. */
async function searchBox(): Promise<void> {
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
}

/** The checkbox: checked by a click, an outline and a tick when it is. */
async function checkbox(): Promise<void> {
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
}

/** The switch: on by a click; disabled, it says why and is dashed. */
async function switchControl(): Promise<void> {
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
}

/** The disclosure: expanded by a click, its icon turned. */
async function disclosure(): Promise<void> {
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
}

it('MP-1-3 fields: text input, textarea, select menu and search', async () => {
  await textFields();
  await selectMenu();
  await searchBox();
});

it('MP-1-3 checkbox, switch and disclosure', async () => {
  await checkbox();
  await switchControl();
  await disclosure();
});
