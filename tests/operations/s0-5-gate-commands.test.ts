// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the gate's own commands, through the real API on a throwaway database.
// `operations.record_gate_item` ticks one item with its https evidence link
// (`gate item recorded`); `operations.change_installation_mode` moves the
// installation from made-up to real data while the readiness check is true
// (`installation mode changed`). Both are a person's, under `operations:manage`
// in the business that operates the installation; never an agent's, never
// under a delegation, and every refusal writes nothing. The shared steps are in
// `s0-5-gate-world.ts`; the cases run in order on one database.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  admin,
  CHANGE,
  directWrites,
  evidence,
  malformedRecords,
  modeRefusedWhileOpen,
  modeToReal,
  names,
  openGateWorld,
  recordedOnce,
  RECORD,
  refusedAlike,
  send,
  type Attempt,
  type GateWorld,
} from './s0-5-gate-world.ts';
import { CLOSING_LINES, closingLine, tableRefusals } from './s0-5-gate-lines.ts';

if (serverUrl === undefined) {
  console.warn('operations/s0-5-gate-commands: DATABASE_URL is unset, so nothing below ran.');
}

let gate: GateWorld;

const BODIES = [
  [RECORD, { item: 'phone-alerts', evidence: evidence('phone-alerts') }],
  [CHANGE, { mode: 'real' }],
] as const;

/** Bea (bravo's operations:manage), mia, noah (operations:read) and a delegated agent: refused, nothing written. */
async function othersRefused(w: GateWorld): Promise<string[]> {
  const { world } = w.harness;
  const agent = async (path: string, body: object) =>
    await call(
      world.api,
      agentPath('alpha', path),
      { operationId: randomUUID(), ...body },
      { ...bearer(world.agent.token), [DELEGATION_HEADER]: w.credential },
    );
  const scope = { status: 403, code: 'SCOPE_NOT_GRANTED' };
  return [
    // Bravo does not operate this installation.
    ...(await refusedAlike(
      w,
      BODIES.map(([path, body]): Attempt => [
        `bea in bravo ${path}`,
        async () => await send(w, path, body, world.bea.token, 'bravo'),
      ]),
      scope,
    )),
    ...(await refusedAlike(
      w,
      BODIES.flatMap(([path, body]): Attempt[] => [
        [`mia ${path}`, async () => await send(w, path, body, world.mia.token)],
        [`noah ${path}`, async () => await send(w, path, body, world.noah.token)],
      ]),
      scope,
    )),
    ...(await refusedAlike(
      w,
      BODIES.map(([path, body]): Attempt => [`agent ${path}`, async () => await agent(path, body)]),
      { status: 403, code: 'DELEGATION_EXCLUDES_OPERATION' },
    )),
  ];
}

/** While no business operates the installation, even alpha's owner is refused. */
async function noOperatorRefused(w: GateWorld): Promise<string[]> {
  await admin(w, 'update ops.installation set operator_business_id = null');
  try {
    return await refusedAlike(
      w,
      BODIES.map(([path, body]): Attempt => [
        `ada, no operator ${path}`,
        async () => await send(w, path, body),
      ]),
      { status: 403, code: 'SCOPE_NOT_GRANTED' },
    );
  } finally {
    await admin(w, 'update ops.installation set operator_business_id = $1', [
      w.harness.world.alpha,
    ]);
  }
}

describe.skipIf(serverUrl === undefined)('S0-5 gate commands', () => {
  beforeAll(async () => {
    gate = await openGateWorld();
  }, 300_000);

  afterAll(async () => {
    await gate?.harness.close();
  });

  it('S0-5 gate item recorded: the operator ticks an item with its https evidence link, once, audited; a malformed item or link is refused and writes nothing', async () => {
    expect(await malformedRecords(gate)).toStrictEqual([]);
    const refusal = await send(gate, RECORD, { item: 'coffee', evidence: evidence('x') });
    expect(names(refusal)).toStrictEqual(['item']);
    expect(JSON.stringify(refusal.body)).not.toContain('coffee');
    await recordedOnce(gate, 'phone-alerts');
  });

  it.each(CLOSING_LINES)('%s', async (_title, item, tries, good) => {
    expect(await closingLine(gate, item, tries, good())).toStrictEqual([]);
  });

  it('S0-5 closing lines, held by the table too: a receipt for the opt-in, or any line with no owner line, is refused by the database itself', async () => {
    expect(await tableRefusals(gate)).toStrictEqual(['refused', 'refused', 'refused', 'refused']);
  });

  it('S0-5 installation mode changed: made-up to real by the operator only while every item is done; never back; the app role writes nothing else directly', async () => {
    expect(await modeRefusedWhileOpen(gate)).toStrictEqual([]);
    expect(await modeToReal(gate)).toStrictEqual([]);
    const answered = await directWrites(gate);
    expect(answered).toStrictEqual(answered.map(([sql]) => [sql, 'denied']));
  });

  it('S0-5 operator only: another business, a person without operations:manage, a delegated agent, and any caller while no business operates the installation, are refused and write nothing', async () => {
    expect(await othersRefused(gate)).toStrictEqual([]);
    expect(await noOperatorRefused(gate)).toStrictEqual([]);
  });
});
