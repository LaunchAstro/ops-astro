// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable max-lines-per-function -- one world per file, its cases in one describe */
//
// C57 part B (#2117): two calls at once on separate connections, a lost response asked again
// and an expired lease each leave one task or none; the task and its link to the request
// commit together or not at all. The task's business, client and source stay derived: a body
// naming any of them is refused, and a lease on another task reaches no request. The step's
// audit row reads back, and a planted marker in the request text reaches no audit row and no
// refusal.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { detailOf } from '../commands/agent-fixture.ts';
import { c57bWorld, type C57bWorld, type WorkerLease } from './c57b-world.ts';

const serverUrl = databaseUrlFromEnvironment();
const MARKER = `canary-${randomUUID()}`;

describe.skipIf(serverUrl === undefined)('one task per approved change request', () => {
  let w: C57bWorld;
  let lease: WorkerLease;

  beforeAll(async () => {
    w = await c57bWorld('c57bonce');
    lease = await w.leaseOn();
  }, 240_000);
  afterAll(async () => await w?.world.db.drop());

  const madeFor = async (id: string) =>
    (await w.requests(w.world.business)).find((request) => request.id === id)?.created_task_id;

  it('two calls at once on separate connections make one task, and both answer it', async () => {
    const id = await w.filed('approve');
    const before = await w.tasks(w.world.business);
    const answers = await Promise.all([w.make(lease, id), w.make(lease, id)]);
    const taskIds = answers.map((answer) => String(detailOf(answer)['taskId']));
    expect(new Set(taskIds).size).toBe(1);
    expect(await w.tasks(w.world.business)).toBe(before + 1);
    expect(await madeFor(id)).toBe(taskIds[0]);
  });

  it('a lost response asked again under its operation id replays the one task', async () => {
    const id = await w.filed('approve');
    const operationId = randomUUID();
    const before = await w.tasks(w.world.business);
    const first = await w.make(lease, id, { operationId });
    const again = await w.make(lease, id, { operationId });
    expect(detailOf(again)['taskId']).toBe(detailOf(first)['taskId']);
    expect(await w.tasks(w.world.business)).toBe(before + 1);
  });

  it('the task and the link roll back together: a failed link leaves no task and the cause pending', async () => {
    const id = await w.filed('approve');
    const before = await w.tasks(w.world.business);
    const trigger = `fail_link_${randomUUID().replaceAll('-', '')}`;
    await w.world.db.admin.execute(
      `create function public.${trigger}() returns trigger language plpgsql as $$
       begin raise exception 'link refused for the test'; end $$`,
    );
    await w.world.db.admin.execute(
      `create trigger ${trigger} before update of created_task_id on public.review_change_requests
       for each row when (new.id = '${id}'::uuid) execute function public.${trigger}()`,
    );
    try {
      await expect(w.make(lease, id)).rejects.toThrow();
    } finally {
      await w.world.db.admin.execute(`drop trigger ${trigger} on public.review_change_requests`);
      await w.world.db.admin.execute(`drop function public.${trigger}()`);
    }
    expect(await w.tasks(w.world.business)).toBe(before);
    expect(await madeFor(id)).toBeNull();
    // Still the pending cause: the next ask makes it.
    expect(isCommandRefusal(await w.make(lease, id))).toBe(false);
    expect(await w.tasks(w.world.business)).toBe(before + 1);
  });

  it('task business, party and provenance stay derived: a body naming them is refused', async () => {
    const id = await w.filed('approve');
    const before = await w.tasks(w.world.business);
    for (const extra of [
      { parentId: w.taskB },
      { client: w.partyB },
      { source: 'person:app' },
      { fields: { title: 'mine' } },
      { recordId: w.taskB },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- one lease, one call at a time
      expect(isCommandRefusal(await w.make(lease, id, extra))).toBe(true);
    }
    expect(await w.tasks(w.world.business)).toBe(before);
    expect(await madeFor(id)).toBeNull();
  });

  it('a lease on another task, and a request of another business, reach nothing', async () => {
    const id = await w.filed('approve');
    const other = await w.leaseOn(w.taskB);
    const before = await w.tasks(w.world.business);
    expect(await w.make(other, id)).toMatchObject({ code: 'NOT_FOUND' });
    expect(await w.make(lease, randomUUID())).toMatchObject({ code: 'NOT_FOUND' });
    expect(await w.tasks(w.world.business)).toBe(before);
    expect(await madeFor(id)).toBeNull();
  });

  it('audit reads back the step, and the request text reaches no audit row or refusal', async () => {
    const id = await w.filed('approve', `Please change this ${MARKER}`);
    // A server-owned field's attempted value is kept on its refusal's audit row by design
    // (T1-N4), so the smuggled source is not the request text the canary watches.
    const refusal = await w.make(lease, id, { source: 'agent:smuggled' });
    expect(JSON.stringify(refusal)).not.toContain(MARKER);
    const made = await w.make(lease, id);
    const taskId = String(detailOf(made)['taskId']);
    const rows = await w.world.db.admin.execute<{
      readonly command: string;
      readonly outcome: string;
      readonly row: string;
    }>(
      `select command, outcome, to_jsonb(a)::text as row from public.audit_events a
        where business_id = $1 and command = 'review.make_change_task'`,
      [w.world.business],
    );
    expect(rows.some((row) => row.outcome === 'applied' && row.row.includes(taskId))).toBe(true);
    const everyAudit = await w.world.db.admin.execute<{ readonly row: string }>(
      'select to_jsonb(a)::text as row from public.audit_events a',
    );
    expect(everyAudit.filter((row) => row.row.includes(MARKER))).toStrictEqual([]);
  });

  it('an expired lease makes nothing and leaves the cause pending', async () => {
    const id = await w.filed('approve');
    await w.world.db.admin.execute(
      `update public.leases set expires_at = now() - interval '1 minute' where id = $1`,
      [lease.leaseId],
    );
    const before = await w.tasks(w.world.business);
    expect(isCommandRefusal(await w.make(lease, id))).toBe(true);
    expect(await w.tasks(w.world.business)).toBe(before);
    expect(await madeFor(id)).toBeNull();
  });
});
