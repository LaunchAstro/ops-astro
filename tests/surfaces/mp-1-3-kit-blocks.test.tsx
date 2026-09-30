// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3, part three: the blocks, the whole catalogue on the gallery, the one
// table head, the one empty state and the field-shaped placeholder, and the
// task page's assignee field while the people list loads.

import { act, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Banner,
  Card,
  DoorCard,
  FormLayout,
  Kpi,
  ListRow,
  Meter,
  MockRegion,
  Table,
  locate,
} from '../../packages/ui/src/kit/blocks.tsx';
import { mount, type Mounted } from './mount.tsx';
import { primitiveSheets } from '../support/primitive-sheets.ts';

const sheet = primitiveSheets();
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

it('MP-1-3 table, card, banner, meter and stat', () => {
  const table = html(
    <Table
      caption="Hours"
      columns={[
        { key: 'name', label: 'Work' },
        { key: 'hours', label: 'Hours', align: 'end', sort: 'descending', onSort: () => {} },
      ]}
      rows={[{ name: 'Homepage', hours: '6.5' }]}
    />,
  );
  expect(table).toContain('<caption class="visually-hidden">Hours</caption>');
  expect(table).toContain(
    '<th scope="col" class="r" aria-sort="descending"><button type="button" class="table__sort">',
  );
  expect(table).toContain('<td class="r">6.5</td>');
  expect(
    html(
      <Card title="Plan" current>
        x
      </Card>,
    ),
  ).toContain('class="card card--current"');
  expect(rule('.card--current')).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--accent\)/u);
  expect(html(<Banner tone="bad">Not saved.</Banner>)).toContain('role="alert"');
  expect(html(<Banner>Heads up.</Banner>)).toContain('class="banner banner--warn" role="status"');
  expect(rule('.banner')).toMatch(/border-left:\s*2px solid var\(--warning\)/u);
  expect(rule('.banner')).not.toMatch(/background/u);
  // The fill is worked out from the number, and clamped: it can never disagree with it.
  expect(html(<Meter label="Hours" value={12} max={20} />)).toContain('style="width:60%"');
  expect(html(<Meter label="Hours" value={5} max={4} />)).toContain('style="width:100%"');
  expect(html(<Meter label="Hours" value={Number.NaN} max={4} />)).toContain('style="width:0%"');
  expect(html(<Meter label="Hours" value={3} max={0} />)).toContain('style="width:0%"');
  expect(html(<Meter label="Hours" value={12} max={20} />)).toContain('role="meter"');
  const kpi = html(<Kpi label="Done" explain="Tasks closed" value="9" of="14" />);
  expect(kpi).toMatch(/<span class="stat__of"> of (<!-- -->)?14<\/span>/u);
  expect(kpi).toContain('role="tooltip"');
  expect(rule('.stat__num')).toMatch(/font-variant-numeric:\s*tabular-nums/u);
});

it('MP-1-3 mock mark, locate flash, door card, list row and form layout', async () => {
  expect(html(<MockRegion word>x</MockRegion>)).toBe(
    '<div class="is-mock"><span class="mocktag">Mock</span>x</div>',
  );
  expect(rule('.is-mock')).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--mock-edge\)/u);
  const target = document.createElement('div');
  document.body.append(target);
  const scroll = vi.fn();
  target.scrollIntoView = scroll;
  locate(target);
  expect(target.classList.contains('flash-target')).toBe(true);
  expect(scroll).toHaveBeenCalledWith({ block: 'center' });
  await act(() => {
    target.dispatchEvent(new Event('animationend'));
  });
  expect(target.classList.contains('flash-target')).toBe(false);
  target.remove();
  expect(sheet).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.flash-target\s*\{\s*animation:\s*none/u,
  );
  const door = html(<DoorCard href="https://example.org" title="Search Console" external />);
  expect(door).toContain('rel="noopener noreferrer"');
  expect(door).toContain('class="doorcard doorcard--card"');
  expect(html(<ListRow title="Old brief" state="archived" />)).toContain('data-state="archived"');
  let submitted = 0;
  mounted = await mount(
    <FormLayout
      label="New task"
      actions={<button type="submit">Create</button>}
      onSubmit={() => {
        submitted += 1;
      }}
    >
      <input aria-label="Title" />
    </FormLayout>,
  );
  await mounted.click('button[type="submit"]');
  expect(submitted).toBe(1);
  expect(rule('.form')).toMatch(/background:\s*var\(--surface-2\)/u);
});
