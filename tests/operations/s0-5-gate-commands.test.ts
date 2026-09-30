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
import { OPT_IN_REGISTER, OWNER_LINES } from '../acceptance/role-case-gate-bodies.ts';
import {
  admin,
  CHANGE,
  closingLine,
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
  type Try,
} from './s0-5-gate-world.ts';

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

const line = (item: string): string => OWNER_LINES[item]!;

/** A lodged form or a receipt keeps it shut; only the register entry, with the owner's line. */
const OPT_IN_TRIES: readonly Try[] = [
  ['no evidence', { statement: line('privacy-opt-in') }, 'evidence'],
  [
    'a receipt',
    { evidence: 'https://mail.example/oaic/receipt-1', statement: line('privacy-opt-in') },
    'evidence',
  ],
  [
    'an OAIC page past the register',
    { evidence: `${OPT_IN_REGISTER}/lodge`, statement: line('privacy-opt-in') },
    'evidence',
  ],
  [
    'a look-alike host',
    {
      evidence: OPT_IN_REGISTER.replace('oaic.gov.au', 'oaic.gov.au.example'),
      statement: line('privacy-opt-in'),
    },
    'evidence',
  ],
  ["the register entry, no owner's line", { evidence: OPT_IN_REGISTER }, 'statement'],
  ["an empty owner's line", { evidence: OPT_IN_REGISTER, statement: '' }, 'statement'],
];

const CLOUDFLARE_TRIES: readonly Try[] = [
  ['no evidence', {}, 'evidence'],
  [
    'the new in custody, the old not shown refused',
    { statement: line('cloudflare-rolled') },
    'evidence',
  ],
  ['the old refused, no custody line', { evidence: evidence('cf') }, 'statement'],
  [
    'a custody note of two lines',
    { evidence: evidence('cf'), statement: 'In custody.\nDone.' },
    'statement',
  ],
];

const TRAINING_TRIES: readonly Try[] = [
  ['the dated line, no evidence link', { statement: line('training-line') }, 'evidence'],
  [
    'an undated line',
    { evidence: evidence('t'), statement: 'Training is off on both.' },
    'statement',
  ],
  [
    'an impossible date',
    { evidence: evidence('t'), statement: 'Off since 2026-02-30.' },
    'statement',
  ],
];

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

  it("S0-5 privacy opt-in: no evidence, a receipt only and a register entry each tried; only the register entry, with the owner's line that the published policy matches it, closes it", async () => {
    const good = {
      evidence: `${OPT_IN_REGISTER}?keys=Agency+Astro`,
      statement: line('privacy-opt-in'),
    };
    expect(await closingLine(gate, 'privacy-opt-in', OPT_IN_TRIES, good)).toStrictEqual([]);
  });

  it('S0-5 Cloudflare credential rolled: with no evidence, with the new credential in custody but the old not shown refused, and with the old refused but no custody line, the gate stays shut; with both it may close', async () => {
    const good = { evidence: evidence('cf'), statement: line('cloudflare-rolled') };
    expect(await closingLine(gate, 'cloudflare-rolled', CLOUDFLARE_TRIES, good)).toStrictEqual([]);
  });

  it('S0-5 training line evidence: the gate refuses to close while the dated model-training line has no evidence link, or no real date', async () => {
    const good = { evidence: evidence('t'), statement: line('training-line') };
    expect(await closingLine(gate, 'training-line', TRAINING_TRIES, good)).toStrictEqual([]);
  });

  it('S0-5 closing lines, held by the table too: a receipt for the opt-in, or any line with no owner line, is refused by the database itself', async () => {
    const insert = async (item: string, link: string, statement: string | null) =>
      await admin(
        gate,
        'insert into ops.gate_items (item, evidence, statement) values ($1, $2, $3)',
        [`${item}`, link, statement],
      ).then(
        () => 'stored',
        (error: unknown) =>
          /violates check constraint/u.test(String(error)) ? 'refused' : String(error),
      );
    await admin(
      gate,
      `delete from ops.gate_items where item in ('privacy-opt-in', 'training-line')`,
    );
    expect([
      await insert('privacy-opt-in', 'https://mail.example/receipt', line('privacy-opt-in')),
      await insert('training-line', evidence('t'), null),
      await insert('training-line', evidence('t'), 'Training is off.'),
      await insert('phone-alerts', evidence('p'), 'a line on one of the eight'),
    ]).toStrictEqual(['refused', 'refused', 'refused', 'refused']);
    await admin(
      gate,
      `insert into ops.gate_items (item, evidence, statement) values
      ('privacy-opt-in', $1, $2), ('training-line', $3, $4)`,
      [OPT_IN_REGISTER, line('privacy-opt-in'), evidence('t'), line('training-line')],
    );
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
