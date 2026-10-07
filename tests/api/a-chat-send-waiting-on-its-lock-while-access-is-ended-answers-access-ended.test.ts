// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 and C71-D: a direct message waiting on its pair lock while the sender's
// access is ended reads the sender's standing again under the access lock, and
// is refused with the answer the door gives that person from then on,
// `AUTH_ACCESS_ENDED`, not the plain `AUTH_NO_MEMBERSHIP`. Nothing is stored.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChatWorld, type ChatWorld } from './c71-d-world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrolCaller } from '../acceptance/cast.ts';
import { CHAT, sendAcrossChange } from './c71-d-lock-world.ts';

/** What `access.end` commits for the sender: the membership ended and an ending written. */
async function endAccess(chat: ChatWorld, personId: string | null, subject: string) {
  const { world } = chat.harness;
  const ended = await world.db.admin.execute(
    `with gone as (
       update public.memberships set active = false, ended_at = now()
        where business_id = $1 and person_id = $2 and active returning person_id)
     insert into public.access_endings (business_id, person_id, login_id, ended_by_actor_id)
     select $1, gone.person_id, l.id, $4 from gone
       join public.logins l on l.business_id = $1 and l.subject = $3
     returning id`,
    [world.alpha, personId, subject, world.ada.actorId],
  );
  expect(ended).toHaveLength(1);
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a chat write whose sender’s access is ended while it waits',
  () => {
    let chat: ChatWorld;
    beforeAll(async () => {
      chat = await createChatWorld('chatended');
    }, 600_000);
    afterAll(async () => {
      await chat?.harness.close();
    });

    it('is refused as access ended, stores nothing, and the next call hears the same', async () => {
      const { world } = chat.harness;
      const from = await enrolCaller(world.db, world.alpha, 'alpha', 'ended-sender', CHAT);
      const body = `ended-sender-${randomUUID()}`;
      const answer = await sendAcrossChange(chat, from, world.mia, body, async () => {
        await endAccess(chat, from.personId, from.subject);
      });
      expect(
        {
          code: answer.code,
          stores: await chat.holding(body),
          nextRead: (await chat.as(from, 'chat.conversations')).code,
        },
        answer.text,
      ).toEqual({ code: 'AUTH_ACCESS_ENDED', stores: [], nextRead: 'AUTH_ACCESS_ENDED' });
    });
  },
);
