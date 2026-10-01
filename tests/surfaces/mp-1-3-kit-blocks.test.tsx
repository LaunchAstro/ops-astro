// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-1-3, part three: the blocks, the whole catalogue on the gallery, the one
// table head, the one empty state and the field-shaped placeholder, and the
// task page's assignee field while the people list loads.

import { readdirSync, readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { act, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import * as ui from '../../packages/ui/src/index.ts';
import {
  Banner,
  Card,
  DoorCard,
  FormLayout,
  Kpi,
  ListRow,
  Meter,
  MockRegion,
  Skeleton,
  Table,
  locate,
} from '../../packages/ui/src/kit/blocks.tsx';
import { GALLERY, Gallery } from '../../packages/ui/src/kit/gallery.tsx';
import { Empty } from '../../packages/ui/src/primitives/Absence.tsx';
import { Assignee } from '../../apps/web/src/screens/task/Lifecycle.tsx';
import { mount, type Mounted } from './mount.tsx';
import { primitiveSheets } from '../support/primitive-sheets.ts';

// Node's URL, not the document's: jsdom replaces the global one.
const root = fileURLToPath(new NodeURL('../..', import.meta.url));
const read = (path: string): string => readFileSync(path, 'utf8');
const sheet = primitiveSheets();
const allSheets = [
  ...readdirSync(`${root}packages/ui/src/styles`).map((f) => `${root}packages/ui/src/styles/${f}`),
  `${root}apps/web/src/styles/6-slice.css`,
].map((path) => ({ path, text: read(path) }));
const rule = (selector: string): string => {
  const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(sheet)?.[1] ?? '';
};
/** Every selector in a sheet, one per entry, comments stripped. */
const selectors = (css: string): readonly string[] =>
  [...css.replaceAll(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{}@;]+)\{/gu)]
    .flatMap((m) => (m[1] ?? '').split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '');
const html = (element: ReactElement): string => renderToStaticMarkup(element);

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('MP-1-3 every catalogue primitive and the four composites are on the gallery with their states', async () => {
  const catalogue = JSON.parse(read(`${root}tests/surfaces/fixtures/mp-1-3-catalogue.json`)) as {
    primitives: readonly string[];
    composites: readonly string[];
    retired: readonly string[];
  };
  const shown = GALLERY.map((e) => e.id).filter((id) => id.startsWith('DS-'));
  // A catalogue primitive missing from the gallery fails, and so does one shown that the catalogue retired.
  expect(shown.toSorted()).toEqual([...catalogue.primitives, ...catalogue.composites].toSorted());
  for (const id of catalogue.retired) expect(shown).not.toContain(id);
  mounted = await mount(<Gallery />);
  for (const entry of GALLERY) {
    const section = mounted.find(`[data-catalogue-id="${entry.id}"]`);
    expect(section, entry.id).not.toBeNull();
    expect(section?.querySelectorAll('[data-gallery-state]').length, entry.id).toBe(
      entry.states.length,
    );
    for (const figure of section?.querySelectorAll('[data-gallery-state]') ?? []) {
      // Every state draws something beside its caption.
      expect(
        figure.children.length,
        `${entry.id} ${String((figure as HTMLElement).dataset['galleryState'])}`,
      ).toBeGreaterThan(1);
    }
  }
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

it('MP-1-3 one table header style', () => {
  const heads = allSheets.flatMap(({ path, text }) =>
    selectors(text)
      .filter((s) => /(^|[\s>+~])th\b|thead|tl__head|table__head/u.test(s))
      .map((s) => `${path.slice(root.length)}: ${s}`),
  );
  // Every table head rule is the one table's.
  expect(heads.length).toBeGreaterThan(0);
  for (const head of heads) expect(head).toMatch(/: \.table th\b/u);
});

it('MP-1-3 one empty state and one field-shaped loading placeholder replace the eight', async () => {
  // The mockup's empty dialects have no rule anywhere.
  const dialects =
    /\.(sbempty|cbd__empty|dp__empty|tl__none|crm__none|thread__none|vnotes__none|bk__none|act__none|ai__empty|tokempty|amap__empty|cbd__menuempty|empty-state)\b/u;
  for (const { path, text } of allSheets) expect(text, path).not.toMatch(dialects);
  // One empty component and one placeholder component in the package's exports.
  const names = Object.keys(ui).filter((n) => /^[A-Z]/u.test(n));
  expect(names.filter((n) => /Empty|None|Blank|Nothing/u.test(n))).toEqual(['Empty']);
  expect(names.filter((n) => /Skeleton|Placeholder|Loading|Spinner/u.test(n))).toEqual([
    'Skeleton',
  ]);
  expect(html(<Empty title="None yet" />)).toContain('class="empty empty--block"');
  expect(html(<Empty look="inline" title="None yet" />)).toContain('class="empty empty--inline"');
  expect(html(<Empty look="row" title="None" />)).toContain('class="empty empty--row"');
  let cleared = false;
  mounted = await mount(
    <Empty
      title="No matches for these filters."
      onClearFilters={() => {
        cleared = true;
      }}
    />,
  );
  expect(mounted.find('.empty')?.className).toBe('empty empty--block empty--filtered');
  await mounted.click('.empty__action button');
  expect(cleared).toBe(true);
  // The field placeholder is the field's own size.
  expect(html(<Skeleton shape="field" />)).toBe(
    '<span class="skel skel--field" aria-hidden="true"></span>',
  );
  expect(rule('.skel--field')).toMatch(/height:\s*38px/u);
  expect(rule('.tf')).toMatch(/height:\s*38px/u);
  expect(sheet).toMatch(
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skel\s*\{\s*animation:\s*none/u,
  );
});

it('MP-1-3 the task page assignee field shows the field-shaped placeholder while the people list loads, at 390 too', async () => {
  mounted = await mount(
    <Assignee
      people={{ outcome: 'loading', previous: null, refusal: null, because: null, grantKey: 'g' }}
      onRetry={() => {}}
      assignee={null}
      disabled={false}
      onAssign={() => {}}
    />,
  );
  const status = mounted.find('[data-outcome="loading"]');
  expect(status?.getAttribute('role')).toBe('status');
  expect(status?.querySelector('.skel--field')).not.toBeNull();
  // The words are for a screen reader; nothing text-shaped sits where the field will be.
  expect(status?.querySelector('p')).toBeNull();
  expect(status?.querySelector('.visually-hidden')?.textContent).toBe('Loading the people…');
  // At 390 the placeholder keeps the field's full width: no narrow-screen rule hides or shrinks it.
  expect(rule('.skel--field')).toMatch(/width:\s*100%/u);
  for (const { path, text } of allSheets) {
    for (const block of text.matchAll(/@media[^{]*\{([\s\S]*?)\n\}/gu)) {
      expect(block[1] ?? '', path).not.toMatch(
        /\.skel(--field)?\s*\{[^}]*(display:\s*none|width)/u,
      );
    }
  }
});

it("the mock label sits in the marked region's top-right corner, over no layout", () => {
  expect(rule('.is-mock > .mocktag')).toMatch(/position:\s*absolute/u);
  expect(rule('.is-mock > .mocktag')).toMatch(/top:\s*0/u);
  expect(rule('.is-mock > .mocktag')).toMatch(/right:\s*0/u);
  expect(html(<MockRegion nested>x</MockRegion>)).toBe(
    '<div class="is-mock is-mock--nested" data-provenance="mock">x</div>',
  );
});

it('MP-1-3 mock mark, locate flash, door card, list row and form layout', async () => {
  expect(html(<MockRegion word>x</MockRegion>)).toBe(
    '<div class="is-mock" data-provenance="mock"><span class="mocktag">Mock</span>x</div>',
  );
  expect(rule('.is-mock')).toMatch(/box-shadow:\s*inset 0 0 0 1px var\(--mock-edge\)/u);
  expect(rule('.is-mock')).toMatch(/position:\s*relative/u);
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
