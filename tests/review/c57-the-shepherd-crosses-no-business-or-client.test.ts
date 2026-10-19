// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each crossing beside its control */
//
// C57 (#2017) isolation: three crossings, each with its status checked. Another business's
// worker and lease reach none of alpha's occurrences or reviews; another client in the same
// business gets no item, and an approver covering only that other client finds no send; another
// person, with no covering or acting within keys that do not reach the decision, finds no send.
// A marker planted in a foreign review's client words never appears in any answer.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { enrol } from '../commands/fixture.ts';
import { clientHere } from '../reads/client-rows.ts';
import {
  approveAs,
  clientPerson,
  footprint,
  itemRecipients,
  noDatabase,
  on,
  raisedOf,
  raisedScene,
  runOf,
  scene,
  shepherd,
  staffDecider,
  useShepherdWorld,
  w,
} from './shepherd-world.ts';

useShepherdWorld('c57isolation');

/** No id of `foreign` appears in any of `answers`. */
function namesNone(answers: readonly unknown[], foreign: readonly string[]): void {
  const text = JSON.stringify(answers);
  for (const id of foreign) expect(text.includes(id), 'a foreign id was answered').toBe(false);
}

/** Approvals audited so far, in every business. */
const approvals = async (): Promise<string | undefined> =>
  (
    await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.audit_events
        where command = 'review.shepherd_approve'`,
    )
  )[0]?.n;

describe.skipIf(noDatabase)('C57 the shepherd crosses no business or client', () => {
  it("C57 isolation: another business's worker and lease cannot run alpha's occurrence or review", async () => {
    const alphaScene = await scene('alpha');
    const alphaRun = await runOf('alpha');
    const bravoScene = await scene('bravo');
    const bravoRun = await runOf('bravo');
    const alphaBefore = await footprint('alpha');
    const bravoBefore = await footprint('bravo');
    const answers = [
      // Bravo's worker, its own lease, in its own business, naming alpha's occurrence.
      await shepherd({ ...bravoRun, occurrenceId: alphaRun.occurrenceId }, alphaScene.review),
      // Bravo's lease presented in alpha's business, for alpha's occurrence.
      await shepherd({ ...alphaRun, lease: bravoRun.lease }, alphaScene.review),
      // Bravo's own occurrence and lease, naming alpha's review.
      await shepherd(bravoRun, alphaScene.review),
      // Alpha's own occurrence and lease, naming bravo's review.
      await shepherd(alphaRun, bravoScene.review),
    ];
    expect(answers).toStrictEqual([
      { kind: 'refused', code: 'LEASE_NOT_OWNED' },
      { kind: 'refused', code: 'LEASE_NOT_OWNED' },
      { kind: 'refused', code: 'NOT_FOUND' },
      { kind: 'refused', code: 'NOT_FOUND' },
    ]);
    namesNone(answers, [
      alphaScene.review,
      alphaScene.task,
      alphaScene.client,
      alphaRun.occurrenceId,
      bravoScene.review,
      bravoScene.marker,
      alphaScene.marker,
    ]);
    expect(await footprint('alpha')).toStrictEqual(alphaBefore);
    expect(await footprint('bravo')).toStrictEqual(bravoBefore);
    // The control: each business's own run raises its own review.
    expect(raisedOf(await shepherd(alphaRun, alphaScene.review)).replayed).toBe(false);
    expect(raisedOf(await shepherd(bravoRun, bravoScene.review)).replayed).toBe(false);
  });

  it('C57 isolation: another client in the same business gets no item, and its approver finds no send', async () => {
    const otherClient = await clientHere(w.db.admin, on('alpha').business, randomUUID());
    const otherPerson = await clientPerson('alpha', otherClient);
    const { scene: s, raised } = await raisedScene('alpha');
    expect(await itemRecipients(raised.commentId)).toStrictEqual([s.recipient.personId]);
    expect(await itemRecipients(raised.commentId)).not.toContain(otherPerson.personId);
    // An approver whose decision key covers only the other client.
    const theirs = await staffDecider('alpha', { kind: 'party', id: otherClient });
    const answer = await approveAs('alpha', theirs, {
      sendId: raised.sendId,
      digest: raised.digest,
    });
    expect(answer).toStrictEqual({ ok: false, code: 'NOT_FOUND' });
    namesNone([answer], [s.review, s.client, s.marker]);
    const [row] = await w.db.admin.execute<{ readonly approved: string | null }>(
      'select approved_digest as approved from public.review_shepherd_sends where id = $1',
      [raised.sendId],
    );
    expect(row?.approved).toBeNull();
    // The control: an approver covering this client approves it.
    const ours = await staffDecider('alpha', { kind: 'party', id: s.client });
    expect(
      await approveAs('alpha', ours, { sendId: raised.sendId, digest: raised.digest }),
    ).toMatchObject({ ok: true });
  });

  it('C57 isolation: another person finds no send, and an agent key is refused before any read', async () => {
    const { scene: s, raised } = await raisedScene('alpha');
    const ask = { sendId: raised.sendId, digest: raised.digest };
    const approvalsBefore = await approvals();
    // A member of the business who holds no decision key.
    const nobody = await enrol(
      w.db.app,
      on('alpha').business,
      `nobody-${randomUUID().slice(0, 6)}`,
    );
    const decider = on('alpha').decider;
    const answers = [
      await approveAs('alpha', nobody, ask),
      // The client's own person, who reads the task but decides nothing.
      await approveAs('alpha', s.recipient, ask),
      // A send id that is no send.
      await approveAs('alpha', decider, { ...ask, sendId: randomUUID() }),
      await approveAs('alpha', decider, { ...ask, sendId: 'not-an-id' }),
    ];
    for (const answer of answers) expect(answer).toStrictEqual({ ok: false, code: 'NOT_FOUND' });
    // The decider's own person through an agent credential, even one that ticked the decision
    // key, is refused before any read: only a person's own session approves a client email.
    const agentKeys = [
      await approveAs('alpha', decider, ask, ['task:read']),
      await approveAs('alpha', decider, ask, ['proposal:decide']),
    ];
    for (const answer of agentKeys) {
      expect(answer).toStrictEqual({ ok: false, code: 'ONLY_A_PERSON_APPROVES' });
    }
    namesNone([...answers, ...agentKeys], [s.review, s.client, s.task, s.marker, raised.commentId]);
    const [row] = await w.db.admin.execute<{ readonly approved: string | null }>(
      'select approved_digest as approved from public.review_shepherd_sends where id = $1',
      [raised.sendId],
    );
    expect(row?.approved).toBeNull();
    // Bravo's decider, in bravo, finds alpha's send nowhere.
    expect(await approveAs('bravo', on('bravo').decider, ask)).toStrictEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await approvals()).toBe(approvalsBefore);
  });
});
