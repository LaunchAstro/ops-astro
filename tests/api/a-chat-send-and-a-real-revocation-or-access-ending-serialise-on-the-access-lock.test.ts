// SPDX-License-Identifier: AGPL-3.0-only
//
// Team chat: a send and a real `grant.revoke` or `access.end`, each sent
// through the command path, serialise on the business's access lock. The send
// takes it shared at the door (`prepareCommand`) and reads the sender's
// standing again under it after its conversation locks (`standsNow`); the
// change takes it exclusively. So either the send commits first and the change
// waits for it, or the change commits first and the send is refused and writes
// nothing: no message and no marker move. A message is never written after the
// change committed.
//
// Three timings, each for a direct and a group send:
// - the send holds the lock (paused at its message write) when the change
//   arrives: the change is seen waiting on the lock, the message is stored,
//   then the change applies;
// - the change holds the lock (paused just after taking it) when the send
//   arrives: the send is seen waiting on the lock, then refused at the door;
// - the change arrives while the send waits on its conversation's lock (held
//   by another connection): the send already holds the access lock shared, so
//   the change waits for the send, which commits first. A real change cannot
//   commit inside that wait, as the raw-SQL proofs of the same window do.
// Every pause is on a connection of its own; every wait is read from pg_locks.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import type { Answer } from '../acceptance/world.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  ownCommand,
  pausedCommand,
  takesLock,
  tracked,
  waitsOn,
  writesMessage,
} from './chat-paused-command-world.ts';
import { CHAT, idOf, writeAcrossChange } from './c71-d-lock-world.ts';
import { createGroupWorld, detailOf, type GroupWorld } from './c71-g-world.ts';

type Change = 'grant.revoke' | 'access.end';
type Send = 'chat.send_direct' | 'chat.send_group';
type Timing = 'send holds the lock' | 'change holds the lock' | 'conversation wait';

/** The refusal each change leaves the sender with from then on. */
const REFUSED: Readonly<Record<Change, string>> = {
  'grant.revoke': 'SCOPE_NOT_GRANTED',
  'access.end': 'AUTH_ACCESS_ENDED',
};

interface Scene {
  readonly who: Caller;
  readonly send: Send;
  readonly change: Change;
  readonly conversationId: string;
  /** The lock the send waits on before its conversation's: the pair's, or the group's own. */
  readonly conversationKey: string;
  readonly accessKey: string;
  /** The send's own fields, with this body. */
  sendFields(body: string): Readonly<Record<string, unknown>>;
  /** The change's own fields. */
  readonly changeFields: Readonly<Record<string, unknown>>;
}

/** A fresh sender holding `chat:comment`, already in a conversation with Mia. */
async function sceneFor(g: GroupWorld, send: Send, change: Change): Promise<Scene> {
  const { world } = g.chat.harness;
  const who = await enrolCaller(world.db, world.alpha, 'alpha', `real-${randomUUID()}`, CHAT);
  let conversationId: string;
  let conversationKey: string;
  if (send === 'chat.send_direct') {
    const opening = await g.chat.send(world.mia, who, 'an opening direct message');
    expect(opening.status, opening.text).toBe(200);
    conversationId = idOf(opening);
    const pair = [who.personId, world.mia.personId].toSorted().join(':');
    conversationKey = `chat.direct:${world.alpha}:${pair}`;
  } else {
    const started = await g.start(g.chat.tess, [who.personId, world.mia.personId], 'real crew');
    expect(started.status, started.text).toBe(200);
    conversationId = String(detailOf(started)['conversationId']);
    conversationKey = `chat.conversation:${world.alpha}:${conversationId}`;
  }
  const grants = await world.db.admin.execute<{ readonly id: string }>(
    `select id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and collection = 'chat' and action = 'comment' and revoked_at is null`,
    [world.alpha, who.personId],
  );
  expect(grants).toHaveLength(1);
  return {
    who,
    send,
    change,
    conversationId,
    conversationKey,
    accessKey: `access:${world.alpha}`,
    sendFields: (body) =>
      send === 'chat.send_direct'
        ? { teammateId: world.mia.personId, body }
        : { conversationId, body },
    changeFields:
      change === 'grant.revoke' ? { grantId: grants[0]?.id } : { holderId: who.personId },
  };
}

async function markerOf(g: GroupWorld, scene: Scene): Promise<string | null> {
  const { world } = g.chat.harness;
  const rows = await world.db.admin.execute<{ readonly at: string | null }>(
    `select last_read_at::text as at from public.team_conversation_members
      where business_id = $1 and conversation_id = $2 and person_id = $3`,
    [world.alpha, scene.conversationId, scene.who.personId],
  );
  return rows[0]?.at ?? null;
}

const codeOf = (result: Readonly<Record<string, unknown>>): string =>
  result['refused'] === true ? String(result['code']) : 'applied';

const changeAs = async (g: GroupWorld, scene: Scene): Promise<Answer> =>
  await g.as(g.chat.harness.world.ada, scene.change, scene.changeFields);

const sendAs = async (g: GroupWorld, scene: Scene, body: string): Promise<Answer> =>
  await g.as(scene.who, scene.send, scene.sendFields(body));

/** The send paused at its message write, holding the access lock shared, when the change arrives. */
async function sendHoldsTheLock(g: GroupWorld, scene: Scene) {
  const { world } = g.chat.harness;
  const body = `held-send-${randomUUID()}`;
  const paused = pausedCommand(
    world.db.appUrl,
    world.alpha,
    scene.who.presented,
    { command: scene.send, ...scene.sendFields(body) },
    { at: writesMessage(body), when: 'before' },
  );
  try {
    await paused.reached;
    const changing = tracked(changeAs(g, scene));
    const changeWaited = await waitsOn(world.db.admin, scene.accessKey, 'exclusive', changing.done);
    paused.release();
    const sent = codeOf(await paused.result);
    const changed = await changing.value;
    return {
      changeWaited,
      sent,
      stored: (await g.chat.holding(body)).length > 0,
      changed: changed.code,
      next: (await sendAs(g, scene, `after-${randomUUID()}`)).code,
    };
  } finally {
    await paused.settle();
  }
}

/** The change paused just after taking the access lock, when the send arrives. */
async function changeHoldsTheLock(g: GroupWorld, scene: Scene) {
  const { world } = g.chat.harness;
  const body = `refused-send-${randomUUID()}`;
  const before = await markerOf(g, scene);
  const paused = pausedCommand(
    world.db.appUrl,
    world.alpha,
    world.ada.presented,
    { command: scene.change, ...scene.changeFields },
    { at: takesLock(scene.accessKey, 'exclusive'), when: 'after' },
  );
  try {
    await paused.reached;
    const sending = tracked(sendAs(g, scene, body));
    const sendWaited = await waitsOn(world.db.admin, scene.accessKey, 'shared', sending.done);
    paused.release();
    const changed = codeOf(await paused.result);
    const sent = await sending.value;
    return {
      sendWaited,
      changed,
      sent: sent.code,
      stored: (await g.chat.holding(body)).length > 0,
      markerMoved: (await markerOf(g, scene)) !== before,
      next: (await sendAs(g, scene, `after-${randomUUID()}`)).code,
    };
  } finally {
    await paused.settle();
  }
}

/** The change arrives while the send waits on its conversation's lock. */
async function changeDuringConversationWait(g: GroupWorld, scene: Scene) {
  const { world } = g.chat.harness;
  const body = `queued-send-${randomUUID()}`;
  let changing: ReturnType<typeof tracked<Readonly<Record<string, unknown>>>> | undefined;
  let changeWaited = false;
  const sent = await writeAcrossChange(
    g.chat,
    scene.conversationKey,
    async () => await sendAs(g, scene, body),
    async () => {
      // On a connection of its own: the send waiting over HTTP holds the API's one.
      changing = tracked(
        ownCommand(world.db.appUrl, world.alpha, world.ada.presented, {
          command: scene.change,
          ...scene.changeFields,
        }),
      );
      const { done } = changing;
      changeWaited = await waitsOn(world.db.admin, scene.accessKey, 'exclusive', done);
    },
  );
  if (changing === undefined) throw new Error('the change was never sent');
  const changed = codeOf(await changing.value);
  return {
    changeWaited,
    sent: sent.code,
    stored: (await g.chat.holding(body)).length > 0,
    changed,
    next: (await sendAs(g, scene, `after-${randomUUID()}`)).code,
  };
}

async function race(g: GroupWorld, send: Send, change: Change, timing: Timing): Promise<void> {
  const scene = await sceneFor(g, send, change);
  const next = REFUSED[change];
  if (timing === 'send holds the lock') {
    expect(await sendHoldsTheLock(g, scene)).toEqual({
      changeWaited: true,
      sent: 'applied',
      stored: true,
      changed: 'ok',
      next,
    });
  } else if (timing === 'change holds the lock') {
    // The door's grant check, read under the lock, refuses it: the session it
    // stands on was resolved before the wait, so an ended access is told
    // SCOPE_NOT_GRANTED here and AUTH_ACCESS_ENDED from the next call on.
    expect(await changeHoldsTheLock(g, scene)).toEqual({
      sendWaited: true,
      changed: 'applied',
      sent: 'SCOPE_NOT_GRANTED',
      stored: false,
      markerMoved: false,
      next,
    });
  } else {
    expect(await changeDuringConversationWait(g, scene)).toEqual({
      changeWaited: true,
      sent: 'ok',
      stored: true,
      changed: 'applied',
      next,
    });
  }
}

const SENDS: readonly Send[] = ['chat.send_direct', 'chat.send_group'];
const CHANGES: readonly Change[] = ['grant.revoke', 'access.end'];

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a chat send and a real revocation or access ending serialise on the access lock',
  () => {
    let g: GroupWorld;
    beforeAll(async () => {
      g = await createGroupWorld('chatrealchange');
    }, 600_000);
    afterAll(async () => {
      await g?.chat.harness.close();
    });

    it.each(SENDS.flatMap((send) => CHANGES.map((change) => ({ send, change }))))(
      '$send holding the access lock commits first and a real $change waits for it',
      async ({ send, change }) => {
        await race(g, send, change, 'send holds the lock');
      },
      60_000,
    );

    it.each(SENDS.flatMap((send) => CHANGES.map((change) => ({ send, change }))))(
      '$send waiting on the access lock a real $change holds is refused and writes nothing',
      async ({ send, change }) => {
        await race(g, send, change, 'change holds the lock');
      },
      60_000,
    );

    it.each(SENDS.flatMap((send) => CHANGES.map((change) => ({ send, change }))))(
      '$send waiting on its conversation lock commits first and a real $change arriving then waits for it',
      async ({ send, change }) => {
        await race(g, send, change, 'conversation wait');
      },
      60_000,
    );
  },
);
