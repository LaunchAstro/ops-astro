// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-3 'plan: unbound' and the empty states (TG-08, TG-09): an absent plan
// is never drawn as an empty one. No bound plan says "plan: unbound" and why
// nothing is placed; no run and no plan says there is nothing to draw; a bound
// plan with no run yet still draws every step, planned; a run outside the
// bound plan is counted in the orphan note, never dropped.

import { describe, expect, it } from 'vitest';
import { mountMap, run, step } from './mp-6-3-fixture.tsx';

describe('MP-6-3 unbound and empty', () => {
  it('MP-6-3 unbound and empty: unbound, no run, a plan with no run and an orphan each say their own thing', async () => {
    const unbound = await mountMap({ plan: 'unbound', nodes: [run('r-1', 'in_progress')] });
    expect(unbound.find('[data-execution-map="unbound"]')).not.toBeNull();
    expect(unbound.find('[data-map="reading"]')?.textContent).toBe('plan: unbound');
    expect(unbound.text()).toContain('no bound plan, so the map is not drawn. Nothing is hidden');
    expect(unbound.find('.tg__canvas')).toBeNull();
    await unbound.unmount();

    const none = await mountMap({ plan: 'unbound', nodes: [] });
    expect(none.find('[data-execution-map="no-run"]')).not.toBeNull();
    expect(none.text()).toContain('No agent run on this task yet, so there is nothing to draw.');
    await none.unmount();

    const fresh = await mountMap({
      plan: 'bound',
      steps: [step('a', []), step('b', ['a'])],
      nodes: [],
    });
    expect(fresh.find('[data-execution-map="bound"]')).not.toBeNull();
    expect(fresh.all('[data-tg-node] .spill').map((one) => one.textContent)).toStrictEqual([
      'Planned',
      'Planned',
    ]);
    expect(fresh.find('[data-map="orphans"]')).toBeNull();
    await fresh.unmount();

    const orphaned = await mountMap({
      plan: 'bound',
      steps: [step('a', [], ['r-1'])],
      nodes: [run('r-1', 'in_progress'), run('r-2', 'unplanned'), run('r-3', 'unplanned')],
    });
    expect(orphaned.find('[data-map="orphans"]')?.textContent).toContain(
      '2 runs sit outside the bound plan',
    );
    await orphaned.unmount();
  });
});
