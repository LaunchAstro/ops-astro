// SPDX-License-Identifier: AGPL-3.0-only
//
// The positive control's recipes for S0-5's gate commands, split from
// `role-case-positive-body.ts` to keep it under the per-file cap. An item is
// recorded once per installation, so the recipe cycles through them all and,
// where the harness can, has the owner clear the item first so its record
// applies. The mode change needs every item done, so it records them all
// once, and again after any clear.

import { randomUUID } from 'node:crypto';
import { GATE_ITEMS } from '../../packages/core-commands/src/index.ts';
import type { BodyContext, Prepared } from './role-case-bodies.ts';

type GateCommand = 'operations.record_gate_item' | 'operations.change_installation_mode';

const evidence = (item: string): string => `https://evidence.example/${item}/${randomUUID()}`;

/** The OAIC's public Privacy Opt-In Register, which lists its entries on the one page. */
export const OPT_IN_REGISTER =
  'https://www.oaic.gov.au/privacy/privacy-registers/privacy-opt-in-register';

/** Made-up owner's lines for the three closing lines (S0-5); the eight items carry none. */
export const OWNER_LINES: Readonly<Record<string, string>> = {
  'privacy-opt-in': 'The published privacy policy matches the register entry.',
  'cloudflare-rolled': "The new credential is in the vault item's password field only.",
  'training-line': 'Model training switched off on both model accounts, 2026-09-28.',
};

/** A record that closes this item or line, with made-up evidence. */
export function gateRecordBody(item: string): Record<string, string> {
  const statement = OWNER_LINES[item];
  if (statement === undefined) return { item, evidence: evidence(item) };
  const link = item === 'privacy-opt-in' ? `${OPT_IN_REGISTER}?keys=Agency+Astro` : evidence(item);
  return { item, evidence: link, statement };
}

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
      return { body: gateRecordBody(item) };
    }
    if (allDone) return { body: { mode: 'real' } };
    for (const item of GATE_ITEMS) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await context.asPerson('operations.record_gate_item', gateRecordBody(item));
      if (answer.code !== 'ok' && answer.code !== 'GATE_ITEM_ALREADY_RECORDED') {
        return { exception: `the gate item ${item} was refused ${String(answer.code)}` };
      }
    }
    allDone = true;
    return { body: { mode: 'real' } };
  };
}
