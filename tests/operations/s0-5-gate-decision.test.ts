// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate's decision, on its own, with two seeded stand-ins (one
// invitation, one client-data) so the invitation leg is proved before any
// real invitation command exists. The same decision is what the command
// envelope asks (`s0-5-readiness.test.ts` drives it through the real API).

import { describe, expect, it } from 'vitest';
import type { DataEffects } from '../../packages/core-wire/src/index.ts';
import { GATE_ITEMS, gateDecision } from '../../packages/core-commands/src/index.ts';

const NONE: DataEffects = { writes: [], intake: [], outside: [], access: false };
const INVITATION_STAND_IN: DataEffects = { ...NONE, access: true };
const CLIENT_DATA_STAND_IN: DataEffects = {
  ...NONE,
  writes: [{ kind: 'records', scope: 'client' }],
};
const MADE_UP_SAFE: DataEffects = {
  ...NONE,
  writes: [{ kind: 'business_settings', scope: 'business' }],
};

describe('S0-5 gate refusals (the decision, seeded stand-ins)', () => {
  it('S0-5 gate refusals: each stand-in is shut by each open item on a real-data installation, and runs once every item is done', () => {
    for (const effects of [INVITATION_STAND_IN, CLIENT_DATA_STAND_IN]) {
      for (const item of GATE_ITEMS) {
        expect(gateDecision(effects, { mode: 'real', open_items: [item] })).toStrictEqual([item]);
      }
      expect(gateDecision(effects, { mode: 'real', open_items: [] })).toStrictEqual([]);
      expect(gateDecision(effects, { mode: 'made-up', open_items: [...GATE_ITEMS] })).toStrictEqual(
        [],
      );
    }
  });

  it('S0-5 gate refusals: a made-up-safe command is never shut', () => {
    expect(gateDecision(MADE_UP_SAFE, { mode: 'real', open_items: [...GATE_ITEMS] })).toStrictEqual(
      [],
    );
  });

  it('S0-5 gate refusals: fail closed: no installation row, or a mode it does not know, shuts every gated command', () => {
    for (const effects of [INVITATION_STAND_IN, CLIENT_DATA_STAND_IN]) {
      expect(gateDecision(effects, null)).toStrictEqual(['installation']);
      expect(gateDecision(effects, { mode: 'staging', open_items: [] })).toStrictEqual([
        'installation',
      ]);
    }
  });
});
