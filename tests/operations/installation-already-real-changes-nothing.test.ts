// SPDX-License-Identifier: AGPL-3.0-only
//
// `operations.change_installation_mode` on an installation already on real
// data has nothing to change: it is refused as no transition, writes nothing to
// either gate table, and its audit event is a refusal, never an applied change.
// The move from made-up to real data still applies, once, with one applied
// audit event. Sent through the real API on a throwaway database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  admin,
  CHANGE,
  modeToReal,
  openGateWorld,
  refusedAlike,
  send,
  type GateWorld,
} from './s0-5-gate-world.ts';

if (serverUrl === undefined) {
  console.warn(
    'operations/installation-already-real: DATABASE_URL is unset, so nothing below ran.',
  );
}

let gate: GateWorld;

/** The mode command's audit events in the operator's business, oldest first. */
async function modeEvents(
  w: GateWorld,
): Promise<{ outcome: string; refusal_code: string | null }[]> {
  return await admin(
    w,
    `select outcome, refusal_code from public.audit_events
      where business_id = $1 and command = 'operations.change_installation_mode'
      order by seq`,
    [w.harness.world.alpha],
  );
}

describe.skipIf(serverUrl === undefined)('an installation already on real data', () => {
  beforeAll(async () => {
    gate = await openGateWorld();
  }, 300_000);

  afterAll(async () => {
    await gate?.harness.close();
  });

  it('the move from made-up to real data applies once and is audited as applied', async () => {
    expect(await modeToReal(gate)).toStrictEqual([]);
    const applied = (await modeEvents(gate)).filter((event) => event.outcome === 'applied');
    expect(applied).toStrictEqual([{ outcome: 'applied', refusal_code: null }]);
  });

  it('real to real is refused as no transition, writes nothing and audits no applied change', async () => {
    const before = await modeEvents(gate);
    const again = async () => await send(gate, CHANGE, { mode: 'real' });
    expect(
      await refusedAlike(gate, [['real to real', again]], {
        status: 409,
        code: 'TRANSITION_NOT_PERMITTED',
      }),
    ).toStrictEqual([]);
    expect((await modeEvents(gate)).slice(before.length)).toStrictEqual([
      { outcome: 'refused', refusal_code: 'TRANSITION_NOT_PERMITTED' },
    ]);
  });
});
