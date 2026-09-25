// SPDX-License-Identifier: AGPL-3.0-only
//
// A foreign gate and a fabricated one answer the same public `NOT_FOUND`
// (minimum contract 8.2 cases 1 and 2; root ruling 2 of dd30aa8).
//
// Both are sent through the real HTTP `task.decide` route by a person who may
// decide in their own business. The foreign gate is a real, pending gate in
// the other business; the fabricated one names nothing anywhere. The status
// and the raw response bytes are compared as they arrive: nothing is
// normalised first, so a refusal that echoed the presented id, or said
// anything that differs between the two, fails here. The attempt is audited
// in the prober's own business and not in the gate's, and the foreign gate is
// left exactly as it was.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { statusOf } from '../../packages/core-records/src/commands/register.ts';
import type { BusinessId } from '../../packages/core-records/src/tenancy/database.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import { bearer, call, createWorld, personPath, serverUrl } from '../acceptance/world.ts';
import type { Caller, World } from '../acceptance/world.ts';

if (serverUrl === undefined) {
  console.warn('commands/gate-not-found: DATABASE_URL is unset, so nothing below ran.');
}

interface Raw {
  readonly status: number;
  readonly text: string;
}

describe.skipIf(serverUrl === undefined)('a foreign or fabricated gate is NOT_FOUND', () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld('gatenf');
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  /** A real, pending gate in the caller's business, through the real routes. */
  async function gateOf(caller: Caller): Promise<{ gateId: string; versionId: string }> {
    const made = await call(
      world.api,
      personPath(caller.businessKey, '/task/create'),
      { operationId: randomUUID(), fields: { title: `a task of ${caller.name}` } },
      bearer(caller.token),
    );
    expect(made.code, 'task.create').toBe('ok');
    const proposed = await call(
      world.api,
      personPath(caller.businessKey, '/task/propose'),
      {
        operationId: randomUUID(),
        recordId: made.body['recordId'],
        expectedRevision: made.body['revision'],
        ...PROPOSAL,
      },
      bearer(caller.token),
    );
    expect(proposed.code, 'task.propose').toBe('ok');
    const detail = proposed.body['detail'] as Record<string, string>;
    return { gateId: String(detail['gateId']), versionId: String(detail['versionId']) };
  }

  /** `task.decide` on ada's prefix, read as the bytes the caller receives. */
  async function decideRaw(
    operationId: string,
    gate: { gateId: string; versionId: string },
  ): Promise<Raw> {
    const response = await world.api.fetch(
      new Request(`http://api.test${personPath('alpha', '/task/decide')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...bearer(world.ada.token) },
        body: JSON.stringify({ operationId, ...gate, decision: 'approve', note: 'probe' }),
      }),
    );
    return { status: response.status, text: await response.text() };
  }

  async function auditIn(business: BusinessId, operationId: string) {
    return await world.db.app.withBusiness(business, async (tx) =>
      (await readAuditEvents(tx))
        .filter((event) => event.operation_id === operationId)
        .map((event) => [event.outcome, event.refusal_code]),
    );
  }

  async function gateRow(gateId: string) {
    const rows = await world.db.admin.execute<Record<string, unknown>>(
      `select * from public.gates where id = $1`,
      [gateId],
    );
    return rows[0];
  }

  it('answers byte-identical NOT_FOUND for both, echoes neither id, and audits at home', async () => {
    const foreign = await gateOf(world.bea);
    const fabricated = { gateId: randomUUID(), versionId: randomUUID() };
    const foreignBefore = await gateRow(foreign.gateId);
    expect(foreignBefore?.['state']).toBe('pending');

    const foreignOperation = randomUUID();
    const fabricatedOperation = randomUUID();
    const toForeign = await decideRaw(foreignOperation, foreign);
    const toFabricated = await decideRaw(fabricatedOperation, fabricated);

    // The whole answer, as sent. No id or reason fragment is stripped first.
    expect(toForeign).toStrictEqual(toFabricated);
    expect(toForeign.status).toBe(statusOf('NOT_FOUND'));
    const body = JSON.parse(toForeign.text) as Record<string, unknown>;
    expect(body['code']).toBe('NOT_FOUND');
    expect(body['refused']).toBe(true);
    for (const id of [foreign.gateId, foreign.versionId, fabricated.gateId, fabricated.versionId]) {
      expect(toForeign.text).not.toContain(id);
    }

    // The prober's own tenant records each attempt; the gate's tenant, none.
    expect(await auditIn(world.alpha, foreignOperation)).toStrictEqual([['refused', 'NOT_FOUND']]);
    expect(await auditIn(world.alpha, fabricatedOperation)).toStrictEqual([
      ['refused', 'NOT_FOUND'],
    ]);
    expect(await auditIn(world.bravo, foreignOperation)).toStrictEqual([]);
    expect(await gateRow(foreign.gateId)).toStrictEqual(foreignBefore);
  });

  it('still decides the caller’s own gate through the same route', async () => {
    const own = await gateOf(world.ada);
    const answer = await decideRaw(randomUUID(), own);
    expect(answer.status).toBe(200);
    expect((await gateRow(own.gateId))?.['state']).toBe('approved');
  });
});
