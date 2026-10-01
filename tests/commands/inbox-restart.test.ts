// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1: restart is a command-layer caller of the proposal writer, so its new
// gate raises decision items in the restart's own transaction, and the
// rejected lineage's items stay as the decision left them (supporting
// checklist: "A superseded version's item is withdrawn and a new one is
// raised", "A cleared item names who decided", "Clearing replays by operation
// identifier"). T3a moves restart to `gate:decide`; the items it raises and
// leaves are this ticket's, so the case runs on today's restart and must hold
// on T3a's.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { clearingWorld, decideBody, detailOf, ok } from './inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('INB-1 restart and the inbox', () => {
  const w = clearingWorld('i1rs');

  const decisionItems = async (taskId: string) =>
    await w.fixture.db.admin.execute<{
      recipient: string;
      fact: string;
      work_state: string;
      closed_by: string | null;
    }>(
      `select recipient_person_id as recipient, fact_id::text as fact, work_state,
              closed_by_person_id as closed_by
         from public.inbox_items where subject_record_id = $1 and reason = 'decision'
        order by raised_at, recipient_person_id`,
      [taskId],
    );

  it('INB-1 restart raises the new gate’s items and leaves the rejected lineage’s items cleared, naming who rejected', async () => {
    const p = await w.proposed('restart me');
    ok(await w.call('task.decide', decideBody(p, 'reject'), w.reviewerToken));
    const rejected = await decisionItems(p.task.id);
    expect(rejected.map((i) => [i.work_state, i.closed_by])).toStrictEqual(
      w.holders().map(() => ['cleared', w.reviewer.personId]),
    );

    const restart = { recordId: p.task.id, lineageId: p.lineageId, operationId: randomUUID() };
    const restarted = detailOf(ok(await w.call('task.restart', restart, w.memberToken)));
    const newGate = String(restarted['gateId']);
    expect(newGate).not.toBe(p.gateId);

    const after = await decisionItems(p.task.id);
    expect(after.filter((i) => i.fact === p.gateId)).toEqual(rejected);
    const raised = after.filter((i) => i.fact === newGate);
    expect(raised.map((i) => [i.recipient, i.work_state, i.closed_by])).toStrictEqual(
      w.holders().map((holder) => [holder, 'open', null]),
    );

    // The same restart again is a replay: nothing new is raised or closed.
    ok(await w.call('task.restart', restart, w.memberToken));
    expect(await decisionItems(p.task.id)).toEqual(after);
  });
});
