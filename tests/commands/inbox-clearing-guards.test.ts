// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 clearing's guards (INB-1c, lines C15, C17, C33 and C34, and the
// separations): no notification path writes a decision or clears without one,
// a pending gate past its expiry stays pending with its items open, a
// cancelled lineage withdraws its items naming nobody, and the clearing keeps
// business to business, client to client and person to person apart. The
// clearing itself is `inbox-clearing.test.ts`; both share one world.

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearDecision,
  raiseInboxItem,
  readInboxItems,
  recordDeliveryAttempt,
  withdrawEndedGates,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { clearingWorld, decideBody, detailOf, ok } from './inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('INB-1 clearing guards', () => {
  const w = clearingWorld('inb1cg');

  it('INB-1 no decision: no notification path writes a decision or clears without one', async () => {
    const gate = await w.proposed('no decision from notifications');
    const writes =
      /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?(?:gates|gate_decisions|proposal_\w+|reservations|envelopes)\b/iu;
    const inbox = join(import.meta.dirname, '..', '..', 'packages/core-records/src/inbox');
    for (const file of readdirSync(inbox)) {
      expect(readFileSync(join(inbox, file), 'utf8'), file).not.toMatch(writes);
    }
    // Every inbox write this part and the earlier ones expose, run on a pending gate.
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      const item = await raiseInboxItem(tx, {
        recipientPersonId: w.writer.personId,
        subjectRecordId: gate.task.id,
        reason: 'mention',
        fact: { kind: 'record', id: gate.task.id },
      });
      await recordDeliveryAttempt(tx, { itemId: item, channel: 'in_app', state: 'delivered' });
      await withdrawEndedGates(tx, gate.task.id);
    });
    // Clearing asks for the durable decision and throws when there is none.
    await expect(
      w.fixture.db.app.withBusiness(
        w.fixture.business,
        async (tx) => await clearDecision(tx, { gateId: gate.gateId, decisionId: randomUUID() }),
      ),
    ).rejects.toThrow(/no decision/u);
    expect(await w.gateState(gate.gateId)).toStrictEqual({ state: 'pending', decisions: 0 });
    expect((await w.itemsOnFact(gate.gateId)).map((i) => i.work_state)).toStrictEqual([
      'open',
      'open',
    ]);
  });

  it('INB-1 expiry: a pending gate past its expiry stays pending, and no setting or refusal turns it into a decision', async () => {
    const gate = await w.proposed('expire me');
    await w.fixture.db.admin.execute(
      `update public.gates set expires_at = now() - interval '1 minute' where id = $1`,
      [gate.gateId],
    );
    const refused = await w.call('task.decide', decideBody(gate), w.reviewerToken);
    expect(refused.body['code']).toBe('GATE_EXPIRED');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await withdrawEndedGates(tx, gate.task.id);
    });
    expect(await w.gateState(gate.gateId)).toStrictEqual({ state: 'pending', decisions: 0 });
    expect(await w.itemsOnFact(gate.gateId)).toMatchObject([
      { work_state: 'open', closed_by: null },
      { work_state: 'open', closed_by: null },
    ]);
    const owed = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await readInboxItems(tx, w.reviewer.personId),
    );
    expect(owed.filter((i) => i.factId === gate.gateId)).toMatchObject([
      { owed: true, workState: 'open' },
    ]);
  });

  it('INB-1 cancel withdraws: a cancelled lineage withdraws its pending gate items without naming a decider', async () => {
    const gate = await w.proposed('cancel me');
    ok(
      await w.call('task.cancel', {
        recordId: gate.task.id,
        lineageId: gate.lineageId,
        reason: 'not needed',
      }),
    );
    expect(await w.gateState(gate.gateId)).toMatchObject({ decisions: 0 });
    expect(await w.itemsOnFact(gate.gateId)).toMatchObject([
      { work_state: 'withdrawn', closed_by: null, operation: null },
      { work_state: 'withdrawn', closed_by: null, operation: null },
    ]);
  });

  it('INB-1 clearing isolation: business to business, client to client and person to person', async () => {
    const clientA = randomUUID();
    const clientB = randomUUID();
    const onA = await w.proposed('client A work', clientA);
    const onB = await w.proposed('client B work', clientB);
    // Person to person: the decider's own mention on the same task, from a teammate.
    ok(
      await w.call(
        'task.comment',
        {
          recordId: onA.task.id,
          expectedRevision: onA.task.rev,
          body: 'have a look',
          audience: 'internal',
          mentions: [w.reviewer.personId],
        },
        w.writerToken,
      ),
    );
    const decided = detailOf(ok(await w.call('task.decide', decideBody(onA), w.reviewerToken)));
    const real = { gateId: onA.gateId, decisionId: String(decided['decisionId']) };

    // Business to business, against a real committed decision: an item still
    // open on alpha's decided gate cannot be cleared from bravo's transaction,
    // which sees neither the decision nor the item, and the same call from
    // alpha's own transaction clears it.
    const late = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: w.fixture.member.personId,
          subjectRecordId: onA.task.id,
          reason: 'decision',
          fact: { kind: 'gate', id: onA.gateId },
        }),
    );
    await expect(
      w.fixture.db.app.withBusiness(w.bravo, async (tx) => await clearDecision(tx, real)),
    ).rejects.toThrow(/no decision/u);
    expect(
      await w.fixture.db.app.withBusiness(
        w.bravo,
        async (tx) => await readInboxItems(tx, w.bravoPerson),
      ),
    ).toStrictEqual([]);
    const lateState = async (): Promise<string | undefined> =>
      (
        await w.fixture.db.admin.execute<{ work_state: string }>(
          'select work_state from public.inbox_items where id = $1',
          [late],
        )
      )[0]?.work_state;
    expect(await lateState()).toBe('open');
    expect(
      await w.fixture.db.app.withBusiness(
        w.fixture.business,
        async (tx) => await clearDecision(tx, real),
      ),
    ).toBe(1);
    expect(await lateState()).toBe('cleared');

    expect((await w.itemsOnFact(onA.gateId)).map((i) => i.work_state)).toStrictEqual([
      'cleared',
      'cleared',
      'cleared',
    ]);
    // Client to client: client B's gate in the same business is untouched.
    expect(await w.itemsOnFact(onB.gateId)).toMatchObject([
      { work_state: 'open', closed_by: null },
      { work_state: 'open', closed_by: null },
    ]);
    // Person to person: only that gate's decision items closed; the decider's
    // mention and the writer's (non-holder's) state are untouched.
    const reviewers = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await readInboxItems(tx, w.reviewer.personId),
    );
    expect(
      reviewers.filter((i) => i.subjectRecordId === onA.task.id && i.reason === 'mention'),
    ).toMatchObject([{ workState: 'open', closedByPersonId: null }]);
    const writers = await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await readInboxItems(tx, w.writer.personId),
    );
    expect(writers.filter((i) => i.reason === 'decision')).toStrictEqual([]);
  });
});
