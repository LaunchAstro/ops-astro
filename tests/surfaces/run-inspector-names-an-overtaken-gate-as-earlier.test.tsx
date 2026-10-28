// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The run inspector's gate card names the gate's state as current only while
// that gate is the step's authority. A pending gate the run has moved past,
// or an approval kept on a superseded run, reads as an earlier snapshot.

import { afterEach, expect, it } from 'vitest';
import { MapInspector } from '../../packages/ui/src/surfaces/agent/execution-inspector.tsx';
import {
  executionMap,
  type MapGate,
  type MapNode,
  type MapStep,
} from '../../packages/ui/src/state/execution-map.ts';
import { mount, type Mounted } from './mount.tsx';
import { gate, run, step } from './mp-6-3-fixture.tsx';

const open: Mounted[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((page) => page.unmount()));
});

async function cardFor(node: MapNode, held: MapGate): Promise<string> {
  const view = executionMap(
    {
      plan: 'bound',
      steps: [step('draft', [], [node.nodeId])],
      nodes: [node],
    },
    [held],
  );
  if (view.kind !== 'bound') throw new Error('the plan should be bound');
  const only: MapStep | undefined = view.steps[0];
  if (only === undefined) throw new Error('the step should be drawn');
  const page = await mount(<MapInspector step={only} />);
  open.push(page);
  return page.find('.gate__word')?.textContent ?? '';
}

it('a pending gate the run has moved past reads as earlier, not as pending now', async () => {
  const card = await cardFor(
    run('r-1', 'in_progress', { runState: 'running' }),
    gate('r-1', 'pending'),
  );
  expect(card).not.toBe('Human approval gate · pending');
  expect(card).toContain('earlier');
});

it('an approval kept on a superseded run reads as earlier, not as approved now', async () => {
  const card = await cardFor(run('r-1', 'superseded'), gate('r-1', 'approved'));
  expect(card).not.toBe('Human approval gate · approved');
  expect(card).toContain('earlier');
});

it('a gate still waiting, and an approval still in force, read as current', async () => {
  expect(await cardFor(run('r-1', 'not_started'), gate('r-1', 'pending'))).toBe(
    'Human approval gate · pending',
  );
  expect(
    await cardFor(run('r-2', 'in_progress', { runState: 'running' }), gate('r-2', 'approved')),
  ).toBe('Human approval gate · approved');
});
