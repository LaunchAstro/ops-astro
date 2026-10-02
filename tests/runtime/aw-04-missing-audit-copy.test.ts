// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-04 missing audit copy`: a copy of the bytes that cannot be written is
// raised as an operator item and does not affect the run. The read keeps its
// bytes, its ledger row and its audit event; the business's team sees one row
// per business and digest on `task.queue`'s outage report, cause
// `audit_copy_missing`, fault ours. A copy the store keeps raises nothing.
// The store's refusal is a trigger planted for one business and one digest.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import {
  identityOf,
  type ReadAuditNote,
  type ReadRequest,
} from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { createTask, type Schedules } from './schedules-harness.ts';
import { cq8World } from './t2d-harness.ts';
import {
  FILES,
  FRAGMENT,
  anotherPersonsAgent,
  leaseOf,
  noDatabase,
  readAs,
  useAw02World,
  w,
} from './aw-02-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw02World('aw04miss');

const DIGEST = identityOf(FRAGMENT, FILES.get(FRAGMENT) ?? new Uint8Array()).digest;

/** The copy store refuses `DIGEST` for these businesses, and only for them. */
async function refuseCopies(owner: Schedules, businesses: readonly string[]): Promise<void> {
  const listed = businesses.map((id) => `'${id}'`).join(', ');
  await owner.db.admin.execute(
    `create or replace function public.aw04_copy_refused() returns trigger
       language plpgsql as $$
     begin
       if new.business_id in (${listed}) and new.content_digest = '${DIGEST}' then
         raise exception 'the audit copy store refused';
       end if;
       return new;
     end $$;
     create or replace trigger aw04_copy_refused before insert on public.bootstrap_bytes
       for each row execute function public.aw04_copy_refused();`,
  );
}

async function requestOf(owner: Schedules, leaseId: unknown): Promise<ReadRequest> {
  const lease = await leaseOf(owner, leaseId);
  return {
    leaseId: String(leaseId),
    holderActorId: lease.holder_actor_id,
    runId: lease.run_id,
    stepId: null,
    path: FRAGMENT,
  };
}

async function queueAs(
  owner: Schedules,
  who: Schedules['decider'] = owner.decider,
): Promise<Record<string, unknown>> {
  return (await executeRead(owner.db.app, owner.business, who.presented, {
    read: 'task.queue',
  } as never)) as Record<string, unknown>;
}

async function outagesOf(owner: Schedules): Promise<readonly Record<string, unknown>[]> {
  return (await queueAs(owner))['outages'] as readonly Record<string, unknown>[];
}

const stored = async (owner: Schedules): Promise<number> =>
  (
    await owner.db.admin.execute(
      'select 1 from public.bootstrap_bytes where business_id = $1 and content_digest = $2',
      [owner.business, DIGEST],
    )
  ).length;

const ledger = async (owner: Schedules, runId: string): Promise<readonly unknown[]> =>
  await owner.db.admin.execute<{ path: string }>(
    `select path, sequence from public.bootstrap_reads
      where business_id = $1 and run_id = $2 order by sequence`,
    [owner.business, runId],
  );

it('AW-04 missing audit copy: a copy that cannot be written keeps the read, its ledger row and its audit event, and raises one operator row per business and digest', async () => {
  await refuseCopies(w.alpha, [w.alpha.business]);
  const mine = await requestOf(w.alpha, w.alphaWork.picked['leaseId']);
  const notes: ReadAuditNote[] = [];

  expect(await readAs(w.alpha, mine, notes)).toBe('read');
  expect(notes).toMatchObject([{ runId: mine.runId, path: FRAGMENT, digest: DIGEST }]);
  expect(await ledger(w.alpha, mine.runId)).toMatchObject([{ sequence: 1 }, { path: FRAGMENT }]);
  expect(await stored(w.alpha)).toBe(0);
  const [first, ...others] = await outagesOf(w.alpha);
  expect(others).toStrictEqual([]);
  expect(first).toMatchObject({
    cause: 'audit_copy_missing',
    fault: 'ours',
    contentDigest: DIGEST,
    closedAt: null,
    runs: [],
  });

  // The same digest missing again joins its one row; the read goes through.
  expect(await readAs(w.alpha, mine, notes)).toBe('read');
  expect(notes).toHaveLength(2);
  const again = await outagesOf(w.alpha);
  expect(again).toHaveLength(1);
  expect(again[0]).toMatchObject({ id: first?.['id'], openedAt: first?.['openedAt'] });
  expect(String(again[0]?.['lastDropAt']) >= String(first?.['lastDropAt'])).toBe(true);
}, 60_000);

it('AW-04 missing audit copy: a copy the store keeps raises nothing', async () => {
  const theirs = await requestOf(w.bravo, w.bravoWork.picked['leaseId']);
  expect(await readAs(w.bravo, theirs, [])).toBe('read');
  expect(await stored(w.bravo)).toBe(1);
  expect(await outagesOf(w.bravo)).toStrictEqual([]);
}, 60_000);

/** Another business: bravo sees none of alpha's row; its own miss is its own row. */
async function anotherBusiness(alphaId: string): Promise<void> {
  expect(JSON.stringify(await queueAs(w.bravo))).not.toContain(alphaId);
  const bravoSees = await w.bravo.db.app.withBusiness(
    w.bravo.business,
    async (tx) =>
      await tx.query('select 1 from public.outage_reports where business_id = $1 or id = $2', [
        w.alpha.business,
        alphaId,
      ]),
  );
  expect(bravoSees).toHaveLength(0);
  await refuseCopies(w.alpha, [w.alpha.business, w.bravo.business]);
  await w.bravo.db.admin.execute(
    'delete from public.bootstrap_bytes where business_id = $1 and content_digest = $2',
    [w.bravo.business, DIGEST],
  );
  const theirs = await requestOf(w.bravo, w.bravoWork.picked['leaseId']);
  expect(await readAs(w.bravo, theirs, [])).toBe('read');
  const [bravoRow, ...more] = await outagesOf(w.bravo);
  expect(more).toStrictEqual([]);
  expect(bravoRow).toMatchObject({ cause: 'audit_copy_missing', contentDigest: DIGEST });
  expect(bravoRow?.['id']).not.toBe(alphaId);
  expect(await outagesOf(w.alpha)).toMatchObject([{ id: alphaId }]);
  expect(JSON.stringify(await queueAs(w.alpha))).not.toContain(String(bravoRow?.['id']));
}

it('AW-04 missing audit copy isolation: another business, another client, another person under a live delegation', async () => {
  const [alphaRow] = await outagesOf(w.alpha);
  const alphaId = String(alphaRow?.['id']);
  expect(alphaRow).toMatchObject({ cause: 'audit_copy_missing', contentDigest: DIGEST });
  const foreign = new RegExp(`${DIGEST}|${alphaId}|audit_copy`, 'u');

  // 1. Another business.
  await anotherBusiness(alphaId);

  // 2. Another client of alpha's, shared one task: the queue and its report
  // are the team's, so the client is refused, naming nothing of alpha's row.
  await w.alpha.db.app.withBusiness(w.alpha.business, async (tx) => {
    await grantTo(tx, w.alpha.decider, 'share');
  });
  const task = await createTask(w.alpha, 'aw04miss client task');
  const client = await cq8World(w.alpha).client(w.alpha.business, w.alpha.decider, 'aw04c', task);
  const clientSees = await queueAs(w.alpha, client);
  expect(clientSees).toMatchObject({ code: 'SCOPE_NOT_GRANTED' });
  expect(JSON.stringify(clientSees)).not.toMatch(foreign);

  // 3. Another person's agent under its own live delegation: an agent's queue
  // carries no outage report.
  const other = await anotherPersonsAgent(w.alpha);
  const agentSees = await executeAgentCommand(
    w.alpha.db.app,
    w.alpha.business,
    { provider: 'supabase', subject: other.subject },
    undefined,
    { command: 'task.queue', operationId: randomUUID() } as never,
  );
  expect(agentSees).toMatchObject({ command: 'task.queue', detail: { queue: [] } });
  expect(JSON.stringify(agentSees)).not.toMatch(foreign);
  expect(JSON.stringify(agentSees)).not.toContain('outage');
}, 180_000);
