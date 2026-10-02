// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the overseas-services register through the real API: a change and an
// approval at once, the refusals under `privacy:manage`, the three crossings
// and the canary. The world is `c81-register-world.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approveLegalVersion } from '../../packages/core-records/src/operations/legal-documents.ts';
import { setOverseasService } from '../../packages/core-records/src/operations/overseas-services.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/surface.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  approve,
  CANARY,
  clientToken,
  closeRegister,
  credential,
  digestOf,
  draft,
  harness,
  listed,
  openRegister,
  publish,
  readPolicy,
  registerRows,
  releasePolicy,
  row,
  SET,
  set,
  setOk,
} from './c81-register-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c81-register-isolation: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openRegister('c81_register_iso');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeRegister();
});

describe.skipIf(serverUrl === undefined)('C81 the overseas-services register', () => {
  it('C81 register change and approval at once: the approval waits for the change and is told the register changed', async () => {
    const drafted = await draft();
    const actorId = harness.world.ada.actorId as string;
    // Two connections, so the two transactions truly overlap: the first sets
    // a row and holds the register's lock for 300 ms before committing, and
    // the approval arrives meanwhile.
    const wide = connect(harness.world.db.appUrl, { source: 'runtime', max: 2 });
    const change = row();
    const first = wide.withBusiness(harness.world.alpha, async (tx) => {
      await setOverseasService(
        tx,
        {
          service: change.service,
          receives: change.receives,
          where: change.where,
          trainsOnIt: change.trainsOnIt,
          contract: change.contract,
          toConfirm: false,
          inUse: true,
        },
        actorId,
      );
      await tx.query('select pg_sleep(0.3)');
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    const second = wide.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await approveLegalVersion(tx, drafted.versionId, digestOf(drafted.body), actorId),
    );
    const outcomes = await Promise.allSettled([first, second]).finally(
      async () => await wide.close(),
    );
    expect(outcomes).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: 'register-changed' },
    ]);
  });
});

describe.skipIf(serverUrl === undefined)('C81 the overseas-services register', () => {
  it('C81 refusal privacy:manage: a holder of operations:read alone, a member and a client are refused the register, and nothing is written', async () => {
    const before = await registerRows(harness.world.alpha);
    for (const token of [harness.world.noah.token, harness.world.mia.token, clientToken]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await set(row(), token);
      expect({ status: answer.status, code: answer.code }).toEqual({
        status: 403,
        code: 'SCOPE_NOT_GRANTED',
      });
    }
    expect(await registerRows(harness.world.alpha)).toEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('C81 the overseas-services register', () => {
  it('C81 isolation: another business, another client and a delegated agent never read or change the register', async () => {
    const alphaRow = row({ service: `alpha only ${randomUUID()}` });
    await setOk(alphaRow);
    const alphaBefore = await registerRows(harness.world.alpha);

    // Another business: bravo's register is bravo's; its rows never reach
    // alpha's policy, and alpha's never reach bravo's.
    const bravoRow = row({ service: `bravo only ${randomUUID()}` });
    await setOk(bravoRow, harness.world.bea.token, 'bravo');
    const bravoPolicy = await releasePolicy(harness.world.bea.token, 'bravo');
    expect(bravoPolicy.json['services']).toEqual([listed(bravoRow)]);
    // A draft of alpha's is not changed by bravo's register moving.
    const alphaDraft = await draft();
    await setOk(row(), harness.world.bea.token, 'bravo');
    expect((await approve(alphaDraft)).status).toBe(200);
    expect((await publish(alphaDraft.versionId)).status).toBe(200);
    const alphaPolicy = await readPolicy('alpha');
    expect(alphaPolicy.text).not.toContain(bravoRow.service);
    expect(bravoPolicy.text).not.toContain(alphaRow.service);

    // Bea on alpha's prefix is no member of alpha.
    const across = await set(row(), harness.world.bea.token, 'alpha');
    expect({ status: across.status, code: across.code }).toEqual({
      status: 403,
      code: 'AUTH_NO_MEMBERSHIP',
    });

    // Another client in the same business: a share does not reach it.
    const client = await set(
      { ...alphaRow, operationId: randomUUID(), receives: 'x' },
      clientToken,
    );
    expect(client.status).toBe(403);
    expect(JSON.stringify(client.body)).not.toContain(alphaRow.service);

    // Another person under a live delegation: the agent acting for Ada, who
    // holds privacy:manage, is refused on the agent prefix.
    const agent = await call(harness.world.api, agentPath('alpha', SET), row(), {
      ...bearer(harness.world.agent.token),
      [DELEGATION_HEADER]: credential,
    });
    expect({ status: agent.status, code: agent.code }).toEqual({
      status: 403,
      code: 'DELEGATION_EXCLUDES_OPERATION',
    });

    expect(await registerRows(harness.world.alpha)).toEqual(alphaBefore);
  });
});

describe.skipIf(serverUrl === undefined)('C81 the overseas-services register', () => {
  it('C81 isolation: a row still to confirm reaches no log, audit row, operation register row, refusal or public read', async () => {
    const logged: string[] = [];
    const capture = (...parts: unknown[]) => void logged.push(parts.map(String).join(' '));
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    const secret = row({ service: `service ${CANARY}`, receives: CANARY, toConfirm: true });
    try {
      await setOk(secret);
      const drafted = await draft();
      const answers = [
        await set(row({ receives: CANARY }), harness.world.mia.token),
        await set(row({ receives: CANARY }), harness.world.bea.token, 'alpha'),
        await approve(drafted),
        await publish(drafted.versionId),
      ];
      for (const answer of answers) {
        expect(answer.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(answer.body)).not.toContain(CANARY);
      }
      for (const key of ['alpha', 'bravo']) {
        // oxlint-disable-next-line no-await-in-loop
        expect((await readPolicy(key)).text).not.toContain(CANARY);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      // Leave the register confirmed for any case after this one.
      await set({ ...secret, operationId: randomUUID(), inUse: false });
    }
    expect(logged.join('\n')).not.toContain(CANARY);

    const stored = await harness.world.db.app.withBusiness(
      harness.world.alpha,
      async (tx) =>
        await tx.query<{ readonly row: string }>(
          `select to_jsonb(e)::text as row from public.audit_events e
          where command in ('privacy.set_overseas_service', 'legal.draft_version')
         union all
         select to_jsonb(o)::text from public.operations o
          where command in ('privacy.set_overseas_service', 'legal.draft_version')`,
        ),
    );
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.map((found) => found.row).join('\n')).not.toContain(CANARY);
  });
});
