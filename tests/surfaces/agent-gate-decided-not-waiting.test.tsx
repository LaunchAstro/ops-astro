// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A decided gate (approved, or changes requested) is drawn as decided: not
// armed, and not "waiting on a person", which would contradict the decision
// recorded under it. Only a pending gate the story waits on is armed.

import { afterEach, describe, expect, it } from 'vitest';
import { lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

const decidedAs = (state: string, decision: string) =>
  lineage({
    versions: [version({ gate: { ...version().gate!, state } })],
    decisions: [{ decision, decidedByPersonId: 'p-9', decidedAt: '2026-09-29T01:02:03.000Z' }],
  });

describe('a decided gate is not drawn as waiting', () => {
  it.each([
    ['approved', 'approve', 'Approved.'],
    ['changes_requested', 'request_changes', 'Changes were requested.'],
  ])('a %s gate is neither armed nor waiting', async (state, decision, says) => {
    const page = await pane({ lineages: [decidedAs(state, decision)] });
    const gate = page.find('[data-agent="gate"]') as HTMLElement | null;
    expect(gate?.dataset['gateKind']).toBe('decided');
    expect(gate?.querySelector('.gate--armed')).toBeNull();
    const sentence = gate?.querySelector('.gate__say')?.textContent ?? '';
    expect(sentence).not.toContain('waiting on a person');
    expect(sentence).toContain(says);
    expect(page.find('[data-gate="decided"]')).not.toBeNull();
  });

  it('a pending gate the story waits on is still armed and waiting', async () => {
    const page = await pane();
    const gate = page.find('[data-agent="gate"]') as HTMLElement | null;
    expect(gate?.dataset['gateKind']).toBe('armed');
    expect(gate?.querySelector('.gate--armed')).not.toBeNull();
    expect(gate?.querySelector('.gate__say')?.textContent).toContain('waiting on a person');
  });
});
