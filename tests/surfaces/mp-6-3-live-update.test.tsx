// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 live update: a step that completes moves the map without a reload.
// While the run is read again the map keeps the graph it drew, so the reader's
// selection stays; the next answer moves the card and its line in place. A
// held graph never crosses to another grant or task.

import { describe, expect, it } from 'vitest';
import { RunMap } from '../../apps/web/src/views/run-map.tsx';
import { mount } from './mount.tsx';
import { run, step } from './mp-6-3-fixture.tsx';

const graphAt = (condition: string, outcome: string | null) => ({
  plan: 'bound' as const,
  sourceRevision: 1,
  complete: true,
  steps: [step('draft', [], ['r-1']), step('send', ['draft'])],
  nodes: [run('r-1', condition, { outcome })],
});

type Graph = Parameters<typeof RunMap>[0]['graph'];
const map = (graph: unknown, loading: boolean, scope = 'alpha:ada T-1') => (
  <RunMap
    graph={graph as Graph}
    proposals={[]}
    read={{ outcome: loading ? 'loading' : 'ready' }}
    scope={scope}
  />
);

describe('MP-6-3 live update', () => {
  it('MP-6-3 live update: the map holds through a re-read and moves in place when the step completes', async () => {
    const page = await mount(map(graphAt('in_progress', null), false));
    const tone = () => (page.find('[data-tg-node="draft"]') as HTMLElement | null)?.dataset['tone'];
    expect(tone()).toBe('run');
    expect(page.find('[data-tg-node="draft"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(page.all('.tg__edge--wait')).toHaveLength(1);

    await page.render(map(undefined, true));
    expect(tone()).toBe('run');
    expect(page.find('[data-tg-node="draft"]')?.getAttribute('aria-pressed')).toBe('true');

    await page.render(map(graphAt('settled', 'completed'), false));
    expect(tone()).toBe('done');
    expect(page.find('[data-tg-node="send"] [data-map="dependency"]')?.textContent).toBe(
      'After draft',
    );
    expect(page.all('.tg__edge--wait')).toHaveLength(0);

    await page.render(map(undefined, true, 'beta:bea T-1'));
    expect(page.find('[data-execution-map]')).toBeNull();
    await page.unmount();
  });
});
