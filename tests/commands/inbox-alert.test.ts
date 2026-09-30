// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 with T2h's alert record: "The alert appears on the task page, in the
// queue read and in the inbox, and nowhere else." A run's settlement raises
// one alert on its task (T2h) and, in the same transaction, the launcher's
// inbox item on the run (INB-1). The inbox entry carries that same alert, the
// one the task page and the queue read show, and only while the task is
// readable; the owed count and the board carry none.

import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { clearingWorld, detailOf, ok } from './inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

type Entry = Readonly<Record<string, unknown>>;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1 the alert in the inbox', () => {
  const w = clearingWorld('i1alert');

  /** A proposal approved, picked up and handed back failed: the run waits on its launcher. */
  const failedRun = async (title: string) => {
    const p = await w.proposed(title);
    const decided = detailOf(
      ok(
        await w.call(
          'task.decide',
          { gateId: p.gateId, versionId: p.versionId, decision: 'approve', note: 'go' },
          w.reviewerToken,
        ),
      ),
    );
    const picked = detailOf(
      ok(
        await w.call(
          'task.pickup',
          { reservationId: decided['reservationId'], leaseSeconds: 600 },
          w.writerToken,
        ),
      ),
    );
    ok(
      await w.call(
        'task.handback',
        { leaseId: picked['leaseId'], fence: picked['fence'], outcome: 'failed' },
        w.writerToken,
      ),
    );
    return p;
  };

  it('INB-1 alert: the inbox entry on a failed run carries the alert the task page and the queue read show', async () => {
    const p = await failedRun('alert me');
    const page = ok(await w.call('task.read', { recordId: p.task.id })).body['task'] as Entry;
    const failed = (page['alerts'] as Entry[]).find((alert) => alert['kind'] === 'failed');
    expect(failed).toBeDefined();
    const queue = ok(await w.call('task.queue', {})).body['alerts'] as Entry[];
    expect(queue.map((alert) => alert['id'])).toContain(failed?.['id']);

    // The launcher is the approver, the reviewer here.
    const inbox = ok(await w.call('inbox.read', {}, w.reviewerToken)).body['inbox'] as Entry[];
    const waiting = inbox.find(
      (entry) => entry['reason'] === 'waiting_run' && entry['subjectRecordId'] === p.task.id,
    );
    expect(waiting).toMatchObject({ access: 'readable', workState: 'open' });
    expect(waiting?.['alert']).toStrictEqual({
      id: failed?.['id'],
      kind: 'failed',
      waitingReason: null,
      raisedAt: failed?.['raisedAt'],
    });
    // Nowhere else: the owed count and the board carry no alert.
    expect(ok(await w.call('inbox.count', {}, w.reviewerToken)).body).not.toHaveProperty('alert');
    expect(
      JSON.stringify(ok(await w.call('task.board', { board: null }, w.reviewerToken)).body),
    ).not.toContain(String(failed?.['id']));
  }, 60_000);

  it("INB-1 alert: only a readable entry carries it, and nobody else's inbox names it", async () => {
    const p = await failedRun('alert withheld');
    const page = ok(await w.call('task.read', { recordId: p.task.id })).body['task'] as Entry;
    const alertId = String((page['alerts'] as Entry[])[0]?.['id']);
    // Person to person: the writer, who handed the run back, holds no item on it.
    expect(JSON.stringify(ok(await w.call('inbox.read', {}, w.writerToken)).body)).not.toContain(
      alertId,
    );
    // Trashed, the reviewer's entry is gone: it names nothing, the alert included.
    await w.fixture.db.admin.execute(
      `update public.records
          set deleted_at = now(), deleted_by_actor_id = $2, trash_batch_id = gen_random_uuid()
        where id = $1`,
      [p.task.id, w.fixture.member.actorId],
    );
    const inbox = ok(await w.call('inbox.read', {}, w.reviewerToken)).body['inbox'] as Entry[];
    const gone = inbox.find((entry) => entry['access'] === 'gone');
    expect(gone).toBeDefined();
    expect(gone).not.toHaveProperty('alert');
    expect(JSON.stringify(inbox)).not.toContain(alertId);
  }, 60_000);
});
