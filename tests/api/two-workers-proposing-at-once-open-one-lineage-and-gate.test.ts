// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { createWorker } from '../../apps/worker/worker.ts';
import { SYNTHETIC_USAGE } from '../../apps/worker/usage.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { asPerson, noDatabase, r, useReceiptWorld } from './aw-08-receipt-world.ts';

useReceiptWorld('proposalrecovery');

const throughApi: Transport = async (path, body, bearer, delegation) =>
  await r.api.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      ...(delegation === undefined ? {} : { 'x-agent-delegation': delegation }),
    },
    body,
  });

async function taskAndDelegation() {
  const created = await asPerson('task.create', {
    operationId: randomUUID(),
    fields: { title: 'Proposal recovery' },
  });
  expect(created.status).toBe(200);
  const taskId = String(created.body['recordId']);
  const credential = await r.fixture.db.app.withBusiness(r.fixture.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: r.fixture.agentActorId,
      delegatePersonId: r.fixture.member.personId,
      mintedByActorId: r.fixture.member.actorId,
      purpose: `proposal_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'comment', 'write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mint refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
  return { taskId, credential };
}

const workerOn = (credential: string, transport: Transport = throughApi) =>
  createWorker({
    transport,
    businessKey: 'alpha',
    credential: r.agentToken,
    delegation: credential,
    reporter: SYNTHETIC_USAGE,
  });

async function counts(taskId: string) {
  const [count] = await r.fixture.db.admin.execute<{ lineages: number; gates: number }>(
    `select (select count(*)::int from public.proposal_lineages
              where business_id = $1 and task_id = $2) as lineages,
            (select count(*)::int from public.gates g join public.proposal_lineages l
               on l.business_id = g.business_id and l.id = g.lineage_id
              where l.business_id = $1 and l.task_id = $2) as gates`,
    [r.fixture.business, taskId],
  );
  return count;
}

/** Each `task.propose` waits until two have arrived, then both go to the API. */
function proposalsHeldUntilBoth(): { readonly held: Transport; readonly arrived: () => number } {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held: Transport = async (path, body, bearer, delegation) => {
    if (path.endsWith('/task/propose')) {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await ready;
    }
    return await throughApi(path, body, bearer, delegation);
  };
  return { held, arrived: () => arrivals };
}

describe.skipIf(noDatabase)('a worker proposal recovered across workers and restarts', () => {
  it('two workers with proposals in flight open one lineage and gate', async () => {
    const { taskId, credential } = await taskAndDelegation();
    const { held, arrived } = proposalsHeldUntilBoth();
    const first = workerOn(credential, held).proposeOnce();
    const second = workerOn(credential, held).proposeOnce();
    await Promise.all([first, second]);
    const arrivals = arrived();
    expect(arrivals).toBe(2);
    expect(await counts(taskId)).toEqual({ lineages: 1, gates: 1 });
  });

  it('restarting after approval recovers the original queued work without a second gate', async () => {
    const { taskId, credential } = await taskAndDelegation();
    const proposed = await workerOn(credential).proposeOnce();
    if (!('proposed' in proposed)) throw new Error('the initial proposal did not apply');
    const [version] = await r.fixture.db.admin.execute<{ id: string }>(
      `select v.id from public.proposal_versions v join public.proposal_lineages l
         on l.business_id = v.business_id and l.id = v.lineage_id
        where l.business_id = $1 and l.task_id = $2`,
      [r.fixture.business, taskId],
    );
    expect(
      (
        await asPerson('task.decide', {
          operationId: randomUUID(),
          gateId: proposed.proposed.gateId,
          versionId: version?.id,
          decision: 'approve',
          note: 'The person clears the original plan',
        })
      ).status,
    ).toBe(200);
    const restarted = workerOn(credential);
    expect(await restarted.proposeOnce()).toEqual({ queued: { taskId } });
    expect(await counts(taskId)).toEqual({ lineages: 1, gates: 1 });
    expect(await restarted.applyOnce(taskId)).toHaveProperty('handedBack');
    const [pending] = await r.fixture.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.gates g join public.proposal_lineages l
         on l.business_id = g.business_id and l.id = g.lineage_id
        where l.business_id = $1 and l.task_id = $2 and g.state = 'pending'`,
      [r.fixture.business, taskId],
    );
    expect(pending?.n).toBe(1);
  });
});
