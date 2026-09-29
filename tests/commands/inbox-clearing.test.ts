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
import { describe, expect, it } from 'vitest';
import { readInboxItems } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { tokenFor as acceptanceToken } from '../acceptance/cast.ts';
import type { World } from '../acceptance/world.ts';
import { serveApi } from '../cli/cli-process-harness.ts';
import { authorised, BUSINESS_KEY, post } from '../api/fixture.ts';
import { clearingWorld, decideBody, detailOf, ok, readable } from './inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('INB-1 clearing', () => {
  const w = clearingWorld('inb1c');

  it('INB-1 clearing rolls back: a raising trigger on the items takes the decision, the gate state and the item down together', async () => {
    const gate = await w.proposed('roll me back');
    expect((await w.itemsOnFact(gate.gateId)).map((i) => i.work_state)).toStrictEqual([
      'open',
      'open',
    ]);
    await w.fixture.db.admin.execute(
      `create function public.inb1c_refuse_clearing() returns trigger language plpgsql as $$
       begin raise exception 'inb1c: clearing refused on purpose'; end $$`,
    );
    await w.fixture.db.admin.execute(
      `create trigger inb1c_refuse_clearing before update on public.inbox_items
         for each row when (new.work_state = 'cleared')
         execute function public.inb1c_refuse_clearing()`,
    );
    try {
      const refused = await w.call('task.decide', decideBody(gate), w.reviewerToken);
      expect(refused.status).not.toBe(200);
      expect(await w.gateState(gate.gateId)).toStrictEqual({ state: 'pending', decisions: 0 });
      expect(await w.itemsOnFact(gate.gateId)).toMatchObject([
        { work_state: 'open', closed_by: null, operation: null },
        { work_state: 'open', closed_by: null, operation: null },
      ]);
    } finally {
      await w.fixture.db.admin.execute(
        'drop trigger inb1c_refuse_clearing on public.inbox_items; drop function public.inb1c_refuse_clearing()',
      );
    }
    // With the fault gone, the same decision commits and clears in one go.
    ok(await w.call('task.decide', decideBody(gate), w.reviewerToken));
    expect(await w.gateState(gate.gateId)).toStrictEqual({ state: 'approved', decisions: 1 });
    expect((await w.itemsOnFact(gate.gateId)).map((i) => i.work_state)).toStrictEqual([
      'cleared',
      'cleared',
    ]);
  });

  it('INB-1 clearing survives kill: the serving process is killed after commit and the database holds the cleared item', async () => {
    const gate = await w.proposed('kill me after commit');
    process.env['GATE_SIGNING_KEY_ID'] = w.fixture.environment.GATE_SIGNING_KEY_ID;
    process.env['GATE_SIGNING_SECRET'] = w.fixture.environment.GATE_SIGNING_SECRET;
    const served = await serveApi({ db: w.fixture.db } as unknown as World);
    try {
      const token = await acceptanceToken(w.reviewer.presented.subject);
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
    const [decision] = await w.fixture.db.admin.execute<{ id: string }>(
      'select id from public.gate_decisions where gate_id = $1',
      [gate.gateId],
    );
    expect(await w.gateState(gate.gateId)).toStrictEqual({ state: 'approved', decisions: 1 });
    expect(await w.itemsOnFact(gate.gateId)).toMatchObject([
      { work_state: 'cleared', closed_by: w.reviewer.personId, operation: decision?.id },
      { work_state: 'cleared', closed_by: w.reviewer.personId, operation: decision?.id },
    ]);
  }, 60_000);

  it('INB-1 cleared names the decider: the second w.reviewer decides and the other w.reviewer item closes naming them', async () => {
    for (const decision of ['approve', 'reject', 'request_changes']) {
      // oxlint-disable-next-line no-await-in-loop
      const gate = await w.proposed(`second w.reviewer ${decision}`);
      // oxlint-disable-next-line no-await-in-loop
      ok(await w.call('task.decide', decideBody(gate, decision), w.reviewerToken));
      // The other reviewer's own read shows the closure and who made it.
      // oxlint-disable-next-line no-await-in-loop
      const theirs = await w.fixture.db.app.withBusiness(
        w.fixture.business,
        async (tx) => await readInboxItems(tx, w.fixture.member.personId),
      );
      expect(
        theirs.filter((i) => readable(i)).filter((i) => i.factId === gate.gateId),
      ).toMatchObject([
        { reason: 'decision', workState: 'cleared', closedByPersonId: w.reviewer.personId },
      ]);
      // oxlint-disable-next-line no-await-in-loop
      const rows = await w.itemsOnFact(gate.gateId);
      expect(rows.map((i) => [i.recipient, i.work_state, i.closed_by])).toStrictEqual(
        w.holders().map((person) => [person, 'cleared', w.reviewer.personId]),
      );
    }
  });

  it('INB-1 clearing replays by operation identifier: the same operation clears once and answers the same', async () => {
    const gate = await w.proposed('replay me');
    const body = { operationId: randomUUID(), ...decideBody(gate) };
    const path = `/api/b/${BUSINESS_KEY}${pathOf('task.decide')}`;
    const first = ok(await post(w.api, path, body, authorised(w.reviewerToken)));
    const before = await w.itemsOnFact(gate.gateId);
    expect(before.every((i) => i.work_state === 'cleared' && i.operation !== null)).toBe(true);
    expect(before.map((i) => i.operation)).toStrictEqual(
      before.map(() => detailOf(first)['decisionId']),
    );
    const again = ok(await post(w.api, path, body, authorised(w.reviewerToken)));
    expect(again.body).toStrictEqual(first.body);
    expect(await w.itemsOnFact(gate.gateId)).toStrictEqual(before);
    expect(await w.gateState(gate.gateId)).toStrictEqual({ state: 'approved', decisions: 1 });
    // A fresh operation on the decided gate is refused and clears nothing more.
    const late = await w.call('task.decide', decideBody(gate), w.memberToken);
    expect(late.status).not.toBe(200);
    expect(await w.itemsOnFact(gate.gateId)).toStrictEqual(before);
  });
});
