// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for S0-5's gate commands, split from
// `role-case-positive-body.ts` to keep it under the per-file cap. An item is
// recorded once per installation, so the recipe cycles through the eight and,
// where the harness can, has the owner clear the item first so its record
// applies. The mode change needs every item done, so it records them all
// once, and again after any clear.

import { randomUUID } from 'node:crypto';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

type GateCommand = 'operations.record_gate_item' | 'operations.change_installation_mode';

const evidence = (item: string): string => `https://evidence.example/${item}/${randomUUID()}`;

export function createGateBody(context: BodyContext): (name: GateCommand) => Promise<Prepared> {
  let sent = 0;
  let allDone = false;
  return async function gateBody(name: GateCommand): Promise<Prepared> {
    if (name === 'operations.record_gate_item') {
      const item = GATE_ITEMS[sent % GATE_ITEMS.length]!;
      sent += 1;
      if (context.clearGateItem !== undefined) {
        await context.clearGateItem(item);
        allDone = false;
      }
      return { body: { item, evidence: evidence(item) } };
    }
    if (allDone) return { body: { mode: 'real' } };
    for (const item of GATE_ITEMS) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await context.asPerson('operations.record_gate_item', {
        item,
        evidence: evidence(item),
      });
      if (answer.code !== 'ok' && answer.code !== 'GATE_ITEM_ALREADY_RECORDED') {
        return { exception: `the gate item ${item} was refused ${String(answer.code)}` };
      }
    }
    allDone = true;
    return { body: { mode: 'real' } };
  };
}
