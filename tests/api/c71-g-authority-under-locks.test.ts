// SPDX-License-Identifier: AGPL-3.0-only
// C71-G group writes under concurrent change: a send, a rename or a member
// change queued on the conversation's lock while the caller's grant is revoked
// or their access ends. Each write is held on the real advisory lock by
// another connection (`c71-d-lock-world.ts`), the change commits, then the
// lock is let go: the write reads the caller's authority again and refuses.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import type { Answer } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { CHAT, writeAcrossChange } from './c71-d-lock-world.ts';
import { createGroupWorld, detailOf, type GroupWorld } from './c71-g-world.ts';

const REVOKE_COMMENT = `update public.grants set revoked_at = greatest(now(), granted_at)
  where business_id = $1 and subject_id = $2 and collection = 'chat'
    and action = 'comment' and revoked_at is null returning id`;
const END_ACCESS = `update public.memberships set active = false, ended_at = now()
  where business_id = $1 and person_id = $2 and active returning id`;

interface Group {
  readonly who: Caller;
  readonly conversationId: string;
  readonly name: string;
}

/** A fresh teammate holding `chat:comment` in a new group: its creator, or a member Tess added. */
async function groupFor(g: GroupWorld, label: string, creator: boolean): Promise<Group> {
  const { world } = g.chat.harness;
  const who = await enrolCaller(world.db, world.alpha, 'alpha', label, CHAT);
  const name = `${label} crew`;
  const started = creator
    ? await g.start(who, [world.ada.personId, world.mia.personId], name)
    : await g.start(g.chat.tess, [who.personId, world.mia.personId], name);
  expect(started.status, started.text).toBe(200);
  return { who, conversationId: String(detailOf(started)['conversationId']), name };
}

/** `invoke`, queued on the group's lock while `sql` commits for `person`. */
async function queued(
  g: GroupWorld,
  group: Group,
  invoke: () => Promise<Answer>,
  sql: string,
  person: string | null = group.who.personId,
): Promise<Answer> {
  const { world } = g.chat.harness;
  return await writeAcrossChange(
    g.chat,
    `chat.conversation:${world.alpha}:${group.conversationId}`,
    invoke,
    async () => {
      const rows = await world.db.admin.execute(sql, [world.alpha, person]);
      expect(rows).toHaveLength(1);
    },
  );
}

/** A queued send: its answer's code, whether any row holds it, Mia reads it, it was audited applied. */
async function sendAcross(g: GroupWorld, group: Group, sql: string, person?: string | null) {
  const body = `queued-group-send-${randomUUID()}`;
  const say = async () => await g.say(group.who, body, group.conversationId);
  const sent = await queued(g, group, say, sql, person);
  return {
    code: sent.code,
    held: (await g.chat.holding(body)).length > 0,
    read: (await g.bodiesOf(g.chat.harness.world.mia, group.conversationId)).includes(body),
    applied: (await g.auditOf('chat.send_group', group.who.actorId)).some(
      (event) => event.outcome === 'applied',
    ),
  };
}

async function revokedSender(g: GroupWorld): Promise<void> {
  const group = await groupFor(g, 'revoked-sender', false);
  expect(await sendAcross(g, group, REVOKE_COMMENT)).toEqual({
    code: 'SCOPE_NOT_GRANTED',
    held: false,
    read: false,
    applied: false,
  });
}

async function endedSender(g: GroupWorld): Promise<void> {
  const group = await groupFor(g, 'ended-sender', false);
  expect(await sendAcross(g, group, END_ACCESS)).toEqual({
    code: 'AUTH_NO_MEMBERSHIP',
    held: false,
    read: false,
    applied: false,
  });
}

/** A creator's rename or member change, queued while their access ends: refused, nothing changed. */
async function endedCreator(
  g: GroupWorld,
  command: 'chat.rename_group' | 'chat.change_members',
): Promise<void> {
  const label = command === 'chat.rename_group' ? 'ended-renamer' : 'ended-changer';
  const group = await groupFor(g, label, true);
  const { ada } = g.chat.harness.world;
  const before = await g.viewOf(ada, group.conversationId);
  expect([before?.name, before?.members.length]).toEqual([group.name, 3]);
  const change =
    command === 'chat.rename_group'
      ? { name: 'renamed after access ended' }
      : { add: [g.zed.personId] };
  const answer = await queued(
    g,
    group,
    async () => await g.as(group.who, command, { conversationId: group.conversationId, ...change }),
    END_ACCESS,
  );
  expect(answer.code, answer.text).toBe('AUTH_NO_MEMBERSHIP');
  expect(await g.viewOf(ada, group.conversationId)).toEqual(before);
  const outcomes = await g.auditOf(command, group.who.actorId);
  expect(outcomes.map((event) => event.outcome)).not.toContain('applied');
}

async function keptSender(g: GroupWorld): Promise<void> {
  const group = await groupFor(g, 'kept-sender', false);
  const { world } = g.chat.harness;
  const bystander = await enrolCaller(world.db, world.alpha, 'alpha', 'bystander', CHAT);
  expect(await sendAcross(g, group, REVOKE_COMMENT, bystander.personId)).toEqual({
    code: 'ok',
    held: true,
    read: true,
    applied: true,
  });
}

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'C71-G group writes under concurrent change',
  () => {
    let g: GroupWorld;
    beforeAll(async () => {
      g = await createGroupWorld('c71gal');
    }, 600_000);
    afterAll(async () => {
      await g?.chat.harness.close();
    });
    it("C71-G a queued group send after the sender's chat:comment is revoked writes no message", async () => {
      await revokedSender(g);
    });
    it("C71-G a queued group send after the sender's access ends writes no message", async () => {
      await endedSender(g);
    });
    it("C71-G a creator's queued rename after their access ends changes nothing", async () => {
      await endedCreator(g, 'chat.rename_group');
    });
    it("C71-G a creator's queued member change after their access ends changes nothing", async () => {
      await endedCreator(g, 'chat.change_members');
    });
    it('C71-G a queued group send by a member who keeps chat:comment is written', async () => {
      await keptSender(g);
    });
  },
);
