// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 an approved gate satisfies the lines after it (TG-06, D-38): once the
// gate on a step's newest run is approved, the line after it draws solid and
// the step after it reads "After", never "Waiting on". A pending gate still
// blocks: dashed, "Waiting on".

import { describe, expect, it } from 'vitest';
import { gate, mountMap, run, step } from './mp-6-3-fixture.tsx';

const graph = {
  plan: 'bound' as const,
  steps: [step('review', [], ['r-1']), step('send', ['review'])],
  nodes: [run('r-1', 'not_started')],
};

describe('MP-6-3 after not waiting', () => {
  it('MP-6-3 after not waiting: an approved gate draws its line solid and the next step reads After', async () => {
    const approved = await mountMap(graph, [gate('r-1', 'approved')]);
    expect(approved.find('[data-tg-node="send"] [data-map="dependency"]')?.textContent).toBe(
      'After review',
    );
    expect(
      approved.all('.tg__edge').map((one) => (one as HTMLElement).dataset['edge']),
    ).toStrictEqual(['satisfied']);
    expect(approved.find('.tg__edge--wait')).toBeNull();
    expect(approved.find('[data-tg-node="send"] .tg__nout')?.textContent).not.toMatch(/WAIT/u);
    expect(approved.text()).not.toMatch(/Waiting on/u);
    await approved.unmount();

    const pending = await mountMap(graph, [gate('r-1', 'pending')]);
    expect(pending.find('[data-tg-node="send"] [data-map="dependency"]')?.textContent).toBe(
      'Waiting on review',
    );
    expect(pending.all('.tg__edge--wait')).toHaveLength(1);
    await pending.unmount();
  });
});
