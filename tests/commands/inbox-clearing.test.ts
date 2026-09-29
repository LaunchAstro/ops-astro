// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 clearing (INB-1c, supporting checklist lines C5, C6, C15, C17, C27,
// C33 and C34). Every decision goes through the mounted API, so an item is
// cleared by the decision's own command inside the decision's own transaction
// and read straight after the answer with no worker running.
//
// Clearing rolls back with the decision (a raising trigger on the items table
// takes the decision row, the gate state and the item down together), survives
// the serving process being killed after commit, names who decided, and
// replays by operation identifier. No notification path writes a decision, and
// a pending gate past its expiry stays pending with its items open.
//
// The separations are named: business to business (another business can
// neither see nor clear this business's items, and its reads stay empty),
// client to client (deciding client A's gate leaves client B's items open in
// the same business) and person to person (a decision closes that gate's
// decision items only, never the decider's or anyone's other items).

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  clearDecision,
  raiseInboxItem,
  readInboxItems,
  recordDeliveryAttempt,
  withdrawEndedGates,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import { tokenFor as acceptanceToken } from '../acceptance/cast.ts';
import type { World } from '../acceptance/world.ts';
import { serveApi } from '../cli/cli-process-harness.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

const ok = (answer: Answer): Answer => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer;
};

const proposal = (task: { id: string; rev: number }) => ({
  recordId: task.id,
  expectedRevision: task.rev,
  purpose: 'draft_reply',
  maximumMinor: 1_000,
  currency: 'AUD',
  payload: { instruction: 'draft' },
  step: { kind: 'compose', payload: {} },
});

const decideBody = (gate: { gateId: string; versionId: string }, decision = 'approve') => ({
  gateId: gate.gateId,
  versionId: gate.versionId,
  decision,
  note: 'decided',
});

interface ItemRow {
  readonly recipient: string;
  readonly work_state: string;
  readonly closed_by: string | null;
  readonly operation: string | null;
  readonly closed_at: Date | null;
}

describe.skipIf(serverUrl === undefined)('INB-1 clearing', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let memberToken: string;
  let reviewer: Member;
  let reviewerToken: string;
  let writer: Member;
  let writerToken: string;
  let bravo: string;
  let bravoPerson: string;

  const call = async (
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    token: string = memberToken,
  ): Promise<Answer> =>
    await post(
      api,
      `/api/b/${BUSINESS_KEY}${pathOf(name)}`,
      { operationId: randomUUID(), ...body },
      authorised(token),
    );

  const newTask = async (title: string, client?: string): Promise<{ id: string; rev: number }> => {
    const created = ok(await call('task.create', { fields: { title } })).body;
    const id = String(created['recordId']);
    if (client === undefined) return { id, rev: Number(created['revision']) };
    const [set] = await fixture.db.admin.execute<{ revision: string }>(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where id = $1 returning revision::text as revision`,
      [id, client],
    );
    return { id, rev: Number(set?.revision) };
  };

  /** A task with a proposal on it: its gate raised one decision item per decide holder. */
  const proposed = async (title: string, client?: string) => {
    const task = await newTask(title, client);
    const detail = detailOf(ok(await call('task.propose', proposal(task), writerToken)));
    return {
      task,
      gateId: String(detail['gateId']),
      versionId: String(detail['versionId']),
      lineageId: String(detail['lineageId']),
    };
  };

  /** Straight from the table as the owner reads it: no read path, no live update. */
  const itemsOnFact = async (factId: string): Promise<readonly ItemRow[]> =>
    await fixture.db.admin.execute<ItemRow>(
      `select recipient_person_id as recipient, work_state, closed_by_person_id as closed_by,
              closed_by_operation_id as operation, closed_at
         from public.inbox_items where fact_id = $1 and reason = 'decision'
        order by recipient_person_id`,
      [factId],
    );

  const gateState = async (gateId: string): Promise<{ state: string; decisions: number }> => {
    const [row] = await fixture.db.admin.execute<{ state: string; decisions: string }>(
      `select g.state, (select count(*) from public.gate_decisions d where d.gate_id = g.id)::text
                as decisions
         from public.gates g where g.id = $1`,
      [gateId],
    );
    return { state: String(row?.state), decisions: Number(row?.decisions) };
  };

  const holders = (): string[] => [fixture.member.personId, reviewer.personId].toSorted();

  beforeAll(async () => {
    fixture = await createApiFixture('inb1c');
    api = fixture.compose();
    memberToken = await tokenFor(fixture.member.presented.subject);
    reviewer = await enrol(fixture.db.app, fixture.business, 'Rhea Reviewer');
    writer = await enrol(fixture.db.app, fixture.business, 'Wes Writer');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      // Sequential: `issueGrant` reads the granter's own rows.
      for (const action of ['read', 'decide'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, reviewer, action);
      }
      for (const action of ['read', 'write', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, writer, action);
      }
    });
    reviewerToken = await tokenFor(reviewer.presented.subject);
    writerToken = await tokenFor(writer.presented.subject);
    bravo = await insertBusiness(fixture.db.app, 'bravo');
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      bravoPerson = await insertPerson(tx, 'Bruno Bravo');
      await insertActor(tx, bravoPerson);
    });
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  it('INB-1 clearing rolls back: a raising trigger on the items takes the decision, the gate state and the item down together', async () => {
    const gate = await proposed('roll me back');
    expect((await itemsOnFact(gate.gateId)).map((i) => i.work_state)).toStrictEqual([
      'open',
      'open',
    ]);
    await fixture.db.admin.execute(
      `create function public.inb1c_refuse_clearing() returns trigger language plpgsql as $$
       begin raise exception 'inb1c: clearing refused on purpose'; end $$`,
    );
    await fixture.db.admin.execute(
      `create trigger inb1c_refuse_clearing before update on public.inbox_items
         for each row when (new.work_state = 'cleared')
         execute function public.inb1c_refuse_clearing()`,
    );
    try {
      const refused = await call('task.decide', decideBody(gate), reviewerToken);
      expect(refused.status).not.toBe(200);
      expect(await gateState(gate.gateId)).toStrictEqual({ state: 'pending', decisions: 0 });
      expect(await itemsOnFact(gate.gateId)).toMatchObject([
        { work_state: 'open', closed_by: null, operation: null },
        { work_state: 'open', closed_by: null, operation: null },
      ]);
    } finally {
      await fixture.db.admin.execute(
        'drop trigger inb1c_refuse_clearing on public.inbox_items; drop function public.inb1c_refuse_clearing()',
      );
    }
    // With the fault gone, the same decision commits and clears in one go.
    ok(await call('task.decide', decideBody(gate), reviewerToken));
    expect(await gateState(gate.gateId)).toStrictEqual({ state: 'approved', decisions: 1 });
    expect((await itemsOnFact(gate.gateId)).map((i) => i.work_state)).toStrictEqual([
      'cleared',
      'cleared',
    ]);
  });

  it('INB-1 clearing survives kill: the serving process is killed after commit and the database holds the cleared item', async () => {
    const gate = await proposed('kill me after commit');
    process.env['GATE_SIGNING_KEY_ID'] = fixture.environment.GATE_SIGNING_KEY_ID;
    process.env['GATE_SIGNING_SECRET'] = fixture.environment.GATE_SIGNING_SECRET;
    const served = await serveApi({ db: fixture.db } as unknown as World);
    try {
      const token = await acceptanceToken(reviewer.presented.subject);
      const response = await fetch(
        `${served.origin}/api/b/${BUSINESS_KEY}${pathOf('task.decide')}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ operationId: randomUUID(), ...decideBody(gate) }),
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      // The one process this test started, by its own pid, the moment the
      // answer (sent after commit) arrives: nothing after the commit runs.
      process.kill(served.pid, 'SIGKILL');
    } finally {
      await served.stop();
    }
    const [decision] = await fixture.db.admin.execute<{ id: string }>(
      'select id from public.gate_decisions where gate_id = $1',
      [gate.gateId],
    );
    expect(await gateState(gate.gateId)).toStrictEqual({ state: 'approved', decisions: 1 });
    expect(await itemsOnFact(gate.gateId)).toMatchObject([
      { work_state: 'cleared', closed_by: reviewer.personId, operation: decision?.id },
      { work_state: 'cleared', closed_by: reviewer.personId, operation: decision?.id },
    ]);
  }, 60_000);

  it('INB-1 cleared names the decider: the second reviewer decides and the other reviewer item closes naming them', async () => {
    for (const decision of ['approve', 'reject', 'request_changes']) {
      // oxlint-disable-next-line no-await-in-loop
      const gate = await proposed(`second reviewer ${decision}`);
      // oxlint-disable-next-line no-await-in-loop
      ok(await call('task.decide', decideBody(gate, decision), reviewerToken));
      // The other reviewer's own read shows the closure and who made it.
      // oxlint-disable-next-line no-await-in-loop
      const theirs = await fixture.db.app.withBusiness(
        fixture.business,
        async (tx) => await readInboxItems(tx, fixture.member.personId),
      );
      expect(theirs.filter((i) => i.factId === gate.gateId)).toMatchObject([
        { reason: 'decision', workState: 'cleared', closedByPersonId: reviewer.personId },
      ]);
      // oxlint-disable-next-line no-await-in-loop
      const rows = await itemsOnFact(gate.gateId);
      expect(rows.map((i) => [i.recipient, i.work_state, i.closed_by])).toStrictEqual(
        holders().map((person) => [person, 'cleared', reviewer.personId]),
      );
    }
  });

  it('INB-1 clearing replays by operation identifier: the same operation clears once and answers the same', async () => {
    const gate = await proposed('replay me');
    const body = { operationId: randomUUID(), ...decideBody(gate) };
    const path = `/api/b/${BUSINESS_KEY}${pathOf('task.decide')}`;
    const first = ok(await post(api, path, body, authorised(reviewerToken)));
    const before = await itemsOnFact(gate.gateId);
    expect(before.every((i) => i.work_state === 'cleared' && i.operation !== null)).toBe(true);
    expect(before.map((i) => i.operation)).toStrictEqual(
      before.map(() => detailOf(first)['decisionId']),
    );
    const again = ok(await post(api, path, body, authorised(reviewerToken)));
    expect(again.body).toStrictEqual(first.body);
    expect(await itemsOnFact(gate.gateId)).toStrictEqual(before);
    expect(await gateState(gate.gateId)).toStrictEqual({ state: 'approved', decisions: 1 });
    // A fresh operation on the decided gate is refused and clears nothing more.
    const late = await call('task.decide', decideBody(gate), memberToken);
    expect(late.status).not.toBe(200);
    expect(await itemsOnFact(gate.gateId)).toStrictEqual(before);
  });

  it('INB-1 no decision: no notification path writes a decision or clears without one', async () => {
    const gate = await proposed('no decision from notifications');
    const writes =
      /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:gates|gate_decisions|proposal_\w+|reservations|envelopes)\b/iu;
    const inbox = join(import.meta.dirname, '..', '..', 'packages/core-records/src/inbox');
    for (const file of readdirSync(inbox)) {
      expect(readFileSync(join(inbox, file), 'utf8'), file).not.toMatch(writes);
    }
    // Every inbox write this part and the earlier ones expose, run on a pending gate.
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      const item = await raiseInboxItem(tx, {
        recipientPersonId: writer.personId,
        subjectRecordId: gate.task.id,
        reason: 'mention',
        fact: { kind: 'record', id: gate.task.id },
      });
      await recordDeliveryAttempt(tx, { itemId: item, channel: 'in_app', state: 'delivered' });
      await withdrawEndedGates(tx, gate.task.id);
    });
    // Clearing asks for the durable decision and throws when there is none.
    await expect(
      fixture.db.app.withBusiness(
        fixture.business,
        async (tx) => await clearDecision(tx, { gateId: gate.gateId, decisionId: randomUUID() }),
      ),
    ).rejects.toThrow(/no decision/u);
    expect(await gateState(gate.gateId)).toStrictEqual({ state: 'pending', decisions: 0 });
    expect((await itemsOnFact(gate.gateId)).map((i) => i.work_state)).toStrictEqual([
      'open',
      'open',
    ]);
  });

  it('INB-1 expiry: a pending gate past its expiry stays pending, and no setting or refusal turns it into a decision', async () => {
    const gate = await proposed('expire me');
    await fixture.db.admin.execute(
      `update public.gates set expires_at = now() - interval '1 minute' where id = $1`,
      [gate.gateId],
    );
    const refused = await call('task.decide', decideBody(gate), reviewerToken);
    expect(refused.body['code']).toBe('GATE_EXPIRED');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await withdrawEndedGates(tx, gate.task.id);
    });
    expect(await gateState(gate.gateId)).toStrictEqual({ state: 'pending', decisions: 0 });
    expect(await itemsOnFact(gate.gateId)).toMatchObject([
      { work_state: 'open', closed_by: null },
      { work_state: 'open', closed_by: null },
    ]);
    const owed = await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => await readInboxItems(tx, reviewer.personId),
    );
    expect(owed.filter((i) => i.factId === gate.gateId)).toMatchObject([
      { owed: true, workState: 'open' },
    ]);
  });

  it('INB-1 cancel withdraws: a cancelled lineage withdraws its pending gate items without naming a decider', async () => {
    const gate = await proposed('cancel me');
    ok(
      await call('task.cancel', {
        recordId: gate.task.id,
        lineageId: gate.lineageId,
        reason: 'not needed',
      }),
    );
    expect(await gateState(gate.gateId)).toMatchObject({ decisions: 0 });
    expect(await itemsOnFact(gate.gateId)).toMatchObject([
      { work_state: 'withdrawn', closed_by: null, operation: null },
      { work_state: 'withdrawn', closed_by: null, operation: null },
    ]);
  });

  it('INB-1 clearing isolation: business to business, client to client and person to person', async () => {
    const clientA = randomUUID();
    const clientB = randomUUID();
    const onA = await proposed('client A work', clientA);
    const onB = await proposed('client B work', clientB);
    // Person to person: the decider's own mention on the same task, from a teammate.
    ok(
      await call(
        'task.comment',
        {
          recordId: onA.task.id,
          expectedRevision: onA.task.rev,
          body: 'have a look',
          audience: 'internal',
          mentions: [reviewer.personId],
        },
        writerToken,
      ),
    );
    // Business to business: bravo cannot clear alpha's items, nor see them.
    await expect(
      fixture.db.app.withBusiness(
        bravo,
        async (tx) => await clearDecision(tx, { gateId: onA.gateId, decisionId: randomUUID() }),
      ),
    ).rejects.toThrow(/no decision/u);
    expect(
      await fixture.db.app.withBusiness(bravo, async (tx) => await readInboxItems(tx, bravoPerson)),
    ).toStrictEqual([]);

    ok(await call('task.decide', decideBody(onA), reviewerToken));

    expect((await itemsOnFact(onA.gateId)).map((i) => i.work_state)).toStrictEqual([
      'cleared',
      'cleared',
    ]);
    // Client to client: client B's gate in the same business is untouched.
    expect(await itemsOnFact(onB.gateId)).toMatchObject([
      { work_state: 'open', closed_by: null },
      { work_state: 'open', closed_by: null },
    ]);
    // Person to person: only that gate's decision items closed; the decider's
    // mention and the writer's (non-holder's) state are untouched.
    const reviewers = await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => await readInboxItems(tx, reviewer.personId),
    );
    expect(
      reviewers.filter((i) => i.subjectRecordId === onA.task.id && i.reason === 'mention'),
    ).toMatchObject([{ workState: 'open', closedByPersonId: null }]);
    const writers = await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => await readInboxItems(tx, writer.personId),
    );
    expect(writers.filter((i) => i.reason === 'decision')).toStrictEqual([]);
  });
});
