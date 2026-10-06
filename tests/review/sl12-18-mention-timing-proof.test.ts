// SPDX-License-Identifier: AGPL-3.0-only
//
// Review proof (SL12-18, the mail-hook join onto mail-timing): fork B's
// mention mail (`tellCommentClients`) sends each client comment item at once
// through `sendInboxEmail`, beside fork A's two timing entries, so it never
// reads the recipient's per-category choice (MP-2-11, read and enforced in
// the send path) nor the daily batch a client comment keeps.

import { expect, it as vitestIt } from 'vitest';
import { tellCommentClients } from '../../packages/core-custody/src/index.ts';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { attemptsOf, noDatabase, useEmailWorld, w } from '../broker/email-world.ts';
import {
  choices,
  commentBy,
  freshInbox,
  timing,
  useTimingWorld,
} from '../broker/email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

it('a client who turned client-comment email off is not mailed on a mention', async () => {
  await freshInbox();
  const comment = await commentBy(w.task, 'person');
  const item = await w.db.app.withBusiness(
    w.alpha,
    async (tx) =>
      await raiseInboxItem(tx, {
        recipientPersonId: w.person,
        subjectRecordId: w.task,
        reason: 'client_comment',
        fact: { kind: 'record', id: comment },
      }),
  );
  choices.set(`${w.person}/client_comment`, 'off');
  const sent = w.provider.outbox.length;
  await tellCommentClients(w.db.app, w.alpha, comment, timing());
  expect(w.provider.outbox.length).toBe(sent);
  expect(await attemptsOf(item)).toEqual([]);
});
