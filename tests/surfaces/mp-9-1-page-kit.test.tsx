// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1, the page kit's page-level parts: one test per supporting checklist
// line this package can prove on its own. The dismiss command's refusal and
// isolation tests run through the API against the one preference store.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Hint,
  Layer,
  SectionHead,
  SectionTip,
  Stat,
  StatRow,
  sectionIndex,
  tipKey,
  visibleTip,
  type TipPreferences,
} from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function tipStore(initial: { dismissed?: string[]; tipsOff?: boolean } = {}): TipPreferences & {
  readonly saved: string[];
} {
  const saved: string[] = [];
  return {
    dismissed: initial.dismissed ?? [],
    tipsOff: initial.tipsOff ?? false,
    dismiss: (key) => {
      saved.push(key);
    },
    saved,
  };
}

describe('MP-9-1 a tip dismissal is stored per person against its page and text', () => {
  it('keys the dismissal by page, tip id and text version', () => {
    const a = tipKey({ page: '/dashboard/portfolio/', id: 'intro', text: 'Read the rollup here.' });
    const b = tipKey({ page: '/dashboard/portfolio/', id: 'intro', text: 'Read the rollup here!' });
    const c = tipKey({ page: '/clients/x/workbench/', id: 'intro', text: 'Read the rollup here.' });
    expect(a.startsWith('/dashboard/portfolio/#intro@')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(
      tipKey({ page: '/dashboard/portfolio/', id: 'intro', text: 'Read the rollup here.' }),
    ).toBe(a);
  });

  it('dismissing hides the tip at once and saves only its own key', async () => {
    const store = tipStore();
    const tip = { page: '/dashboard/portfolio/', id: 'intro', text: 'Read the rollup here.' };
    mounted = await mount(<SectionTip tip={tip} preferences={store} />);
    // The kit's info banner (DS-PRIM-22), dismissed by the kit's icon button.
    expect(mounted.find('.sectip .banner.banner--info .banner__body')?.textContent).toBe(
      'Read the rollup here.',
    );
    await mounted.click('.sectip .banner button.ibtn[aria-label="Dismiss this tip"]');
    expect(store.saved).toEqual([tipKey(tip)]);
    expect(mounted.find('.sectip')).toBeNull();
  });

  it('a dismissed tip stays hidden on the next load, a rewritten one comes back', () => {
    const tip = { page: '/p/', id: 'intro', text: 'Old words.' };
    const store = tipStore({ dismissed: [tipKey(tip)] });
    expect(visibleTip(tip, store)).toBe(false);
    expect(visibleTip({ ...tip, text: 'New words.' }, store)).toBe(true);
  });

  it('tips off hides every tip', () => {
    const store = tipStore({ tipsOff: true });
    expect(visibleTip({ page: '/p/', id: 'a', text: 'x' }, store)).toBe(false);
  });
});

describe('MP-9-1 layers open or shut as drawn', () => {
  it('first and second layers open, third layers shut, and a drawn state wins', async () => {
    mounted = await mount(
      <div>
        <Layer order={1} title="Revenue" count={3}>
          <p>one</p>
        </Layer>
        <Layer order={2} title="Costs">
          <p>two</p>
        </Layer>
        <Layer order={3} title="Detail">
          <p>three</p>
        </Layer>
        <Layer order={1} title="Drawn shut" open={false}>
          <p>four</p>
        </Layer>
      </div>,
    );
    const open = mounted.all('details.layer').map((el) => (el as HTMLDetailsElement).open);
    expect(open).toEqual([true, true, false, false]);
    expect(mounted.find('details.layer summary.layer__sum')?.textContent).toContain('3');
  });
});

describe('MP-9-1 KPI tiles with delta, term tips and of-tracks', () => {
  it('draws the label, number, of, track and a signed delta', async () => {
    mounted = await mount(
      <StatRow columns={3}>
        <Stat
          label="Tasks done"
          value={12}
          of={20}
          track
          delta={{ value: -3, period: 'last week' }}
        />
        <Stat label="Hours" value={41.5} suffix="h" term="Tracked time on tasks you can see." />
        <Stat label="Clients" value={7} />
      </StatRow>,
    );
    const first = mounted.all('.stat')[0];
    expect(first?.querySelector('.stat__label')?.textContent).toBe('Tasks done');
    expect(first?.querySelector('.stat__num')?.textContent).toContain('12');
    expect(first?.querySelector('.stat__of')?.textContent?.trim()).toBe('of 20');
    const meter = first?.querySelector('[role="meter"]');
    expect(meter?.className).toBe('meter meter--stat');
    expect(meter?.getAttribute('aria-valuenow')).toBe('12');
    expect(meter?.getAttribute('aria-valuemax')).toBe('20');
    const fill = meter?.querySelector('.meter__fill') as HTMLElement | null;
    expect(fill?.style.width).toBe('60%');
    expect(first?.querySelector('.delta')?.className).toContain('delta--down');
    expect(first?.querySelector('.delta')?.textContent).toBe('−3 on last week');
  });

  it('a term tip shows its definition on hover and on keyboard focus', async () => {
    mounted = await mount(
      <StatRow columns={2}>
        <Stat label="Hours" value={4} term="Tracked time on tasks you can see." />
        <Stat label="Clients" value={7} />
      </StatRow>,
    );
    const term = mounted.find('.stat__label .term');
    expect(term?.getAttribute('tabindex')).toBe('0');
    const described = term?.getAttribute('aria-describedby') ?? '';
    const tip = mounted.find(`#${described}`);
    expect(tip?.getAttribute('role')).toBe('tooltip');
    expect(tip?.textContent).toBe('Tracked time on tasks you can see.');
    expect(term?.getAttribute('title')).toBeNull();
  });
});

describe('MP-9-1 KPI tiles with delta, term tips and of-tracks: the track', () => {
  it('draws no track unless asked, and none against a zero total', async () => {
    mounted = await mount(
      <StatRow columns={2}>
        <Stat label="Done" value={3} of={20} />
        <Stat label="Empty" value={0} of={0} track />
      </StatRow>,
    );
    expect(mounted.all('.stat__label').map((label) => label.textContent)).toEqual([
      'Done',
      'Empty',
    ]);
    expect(mounted.find('[role="meter"]')).toBeNull();
  });

  it('refuses a track with no total rather than drawing an empty bar', async () => {
    mounted = await mount(
      <StatRow columns={2}>
        <Stat label="Open" value={3} track />
        <Stat label="Clients" value={7} />
      </StatRow>,
    );
    expect(mounted.find('.stat__label')?.textContent).toBe('Open');
    expect(mounted.find('[role="meter"]')).toBeNull();
  });
});

describe('MP-9-1 stat rows follow the column rules at 1279, 900 and 640', () => {
  it('declares the columns as a prop and narrows at each width', async () => {
    mounted = await mount(
      <StatRow columns={5}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Stat key={n} label={`L${n}`} value={n} />
        ))}
      </StatRow>,
    );
    expect(mounted.find('.statrow')?.className).toBe('statrow statrow--5');
    const css = readFileSync(
      join(process.cwd(), 'packages/ui/src/styles/7-page-kit.css'),
      'utf8',
    ).replaceAll(/\/\*[\s\S]*?\*\//gu, '');
    const rule = (width: number): string =>
      css.match(
        new RegExp(`@media \\((?:max-width: |width <= )${width}px\\) \\{([\\s\\S]*?)\\n\\}`, 'u'),
      )?.[1] ?? '';
    expect(rule(1279)).toMatch(/\.statrow--[456][^{]*\{[^}]*repeat\(3, minmax\(0, 1fr\)\)/u);
    expect(rule(900)).toMatch(/\.statrow[^{]*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/u);
    expect(rule(640)).toMatch(/\.statrow[^{]*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/u);
    // The figure steps down to the declared narrow figure style (MP-1-4's scale).
    expect(rule(640)).toMatch(/\.stat__num[^{]*\{[^}]*font: var\(--type-num-md\)/u);
  });
});

describe('MP-9-1 no hint button ships without an action', () => {
  it('a hint with an action draws the kit ghost button that runs it', async () => {
    let ran = 0;
    mounted = await mount(
      <Hint text="Two tasks wait on you." action={{ label: 'Open them', run: () => (ran += 1) }} />,
    );
    expect(mounted.all('.banner--hint button.btn--ghost')).toHaveLength(1);
    await mounted.click('.banner--hint button');
    expect(ran).toBe(1);
  });

  it('a hint with no action draws no button at all', async () => {
    mounted = await mount(<Hint text="Two tasks wait on you." />);
    expect(mounted.find('.banner__body')?.textContent).toBe('Two tasks wait on you.');
    expect(mounted.all('.banner--hint button')).toHaveLength(0);
  });
});

describe('MP-9-1 the hint is the kit banner hint, never a look of its own', () => {
  it('draws the kit Banner in its hint tone: an aside marked AI, with no status role', async () => {
    mounted = await mount(<Hint text="Two tasks wait on you." />);
    const aside = mounted.find('aside.banner.banner--hint');
    expect(aside).not.toBeNull();
    expect(aside?.getAttribute('role')).toBeNull();
    expect(mounted.find('.banner--hint .banner__mark')?.textContent).toBe('AI');
    expect(mounted.all('.hint, .hint__text, .hint__act')).toHaveLength(0);
  });
});

describe('MP-9-1 section heads number top to bottom', () => {
  it('formats the index as three digits and places the tip under the title', async () => {
    const store = tipStore();
    mounted = await mount(
      <SectionHead
        index={sectionIndex(9)}
        title="Skill costing"
        right="4 skills"
        tip={{ page: '/p/', id: 'costing', text: 'Costs are per run.' }}
        preferences={store}
      />,
    );
    expect(mounted.find('.sec__meta .marker')?.textContent).toBe('009');
    expect(mounted.find('h2.sec__head')?.textContent).toBe('Skill costing');
    expect(mounted.find('.sec__meta')?.textContent).toContain('4 skills');
    const order = mounted.all('.sec > *').map((el) => el.className.split(' ')[0]);
    expect(order).toEqual(['sec__meta', 'sec__head', 'sectip']);
    expect(mounted.find('.sec > .sectip > .banner.banner--info')).not.toBeNull();
  });

  it('refuses an index that is not a whole number from 1', () => {
    expect(() => sectionIndex(0)).toThrow(RangeError);
    expect(() => sectionIndex(1.5)).toThrow(RangeError);
  });
});
