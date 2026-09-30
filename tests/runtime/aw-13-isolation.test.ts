// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-13 isolation: one business's export carries only its own runs and moves
// no other business's cursor; two clients' tasks in one business leave as
// spans that name neither client, neither task and no site; and another
// person's agent, under its own live delegation, reaches no trace operation.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeAgentCommand, isCommandRefusal } from '../../packages/core-commands/src/index.ts';
import { derivedId } from '../../packages/core-runtime/src/index.ts';
import { grantTo } from '../commands/fixture.ts';
import { cq8World } from './cq-8-world.ts';
import { codeOf, liveWork, rows, type Schedules } from './schedules-harness.ts';
import { cursorOf, drain, noDatabase, spanIds, t, TRACE_KEY, useAw13World } from './aw-13-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useAw13World('aw13iso');

async function eventSpanIds(s: Schedules, runId: unknown): Promise<string[]> {
  const found = await rows<{ id: string }>(
    t.alpha,
    'select id from public.run_events where business_id = $1 and run_id = $2',
    [s.business, runId],
  );
  return found.map((row) => derivedId(TRACE_KEY, ['span', s.business, row.id], 16));
}

/** Another person's agent under its own live delegation reaches no trace operation. */
async function agentReachesNoTrace(credential: string, sent: readonly string[]): Promise<void> {
  for (const command of ['trace.read', 'trace.export']) {
    // eslint-disable-next-line no-await-in-loop -- one refusal at a time
    const answer = await executeAgentCommand(
      t.alpha.db.app,
      t.alpha.business,
      t.alpha.agent,
      credential,
      {
        command,
        operationId: randomUUID(),
      } as never,
    );
    expect(isCommandRefusal(answer), command).toBe(true);
    expect(codeOf(answer as never), command).toBe('DELEGATION_EXCLUDES_OPERATION');
    for (const id of sent) expect(JSON.stringify(answer).includes(id), id).toBe(false);
  }
}

/** A tenant transaction sees only its own business's export rows. */
async function tenantSeesOnlyItsOwn(business: string): Promise<void> {
  const seen = await t.alpha.db.app.withBusiness(
    business,
    async (tx) =>
      await tx.query<{ n: string }>(
        `select (select count(*) from public.trace_export_cursors where business_id <> $1)
              + (select count(*) from public.trace_export_gaps where business_id <> $1) as n`,
        [business],
      ),
  );
  expect(Number(seen[0]?.n)).toBe(0);
}

it('AW-13 isolation: another business, two clients in one business and another person under a live delegation: each crossing carries or reaches nothing of the other', async () => {
  const { alpha, bravo } = t;
  await drain(alpha);
  await drain(bravo);
  const site = `https://client-${randomUUID()}.example`;
  const first = await liveWork(alpha, `aw13-iso-c1 ${site}/one`, 1_000);
  const second = await liveWork(alpha, `aw13-iso-c2 ${site}/two`, 1_000);
  const foreign = await liveWork(bravo, `aw13-iso-bravo-${randomUUID()}`, 1_000);
  await alpha.db.app.withBusiness(
    alpha.business,
    async (tx) => await grantTo(tx, alpha.decider, 'share'),
  );
  const world = cq8World(alpha);
  const c1 = await world.client(alpha.business, alpha.decider, 'aw13-c1', first.taskId);
  const c2 = await world.client(alpha.business, alpha.decider, 'aw13-c2', second.taskId);
  const bravoCursor = await cursorOf(bravo);

  const from = t.target.received.length;
  await drain(alpha);
  const bodies = t.target.received.slice(from);
  const sent = spanIds(bodies);
  // Alpha's own runs left (the positive control); bravo's did not.
  for (const work of [first, second])
    for (const id of await eventSpanIds(alpha, work.picked['runId'])) expect(sent).toContain(id);
  for (const id of await eventSpanIds(bravo, foreign.picked['runId']))
    expect(sent).not.toContain(id);
  expect(await cursorOf(bravo)).toBe(bravoCursor);
  // Neither client, task nor site is named in what left.
  const text = bodies.join('\n');
  for (const needle of [
    site,
    first.taskId,
    second.taskId,
    c1.personId,
    c2.personId,
    foreign.taskId,
  ])
    expect(text.includes(needle), needle).toBe(false);

  await agentReachesNoTrace(String(first.picked['credential']), sent);
  await tenantSeesOnlyItsOwn(bravo.business);
});
