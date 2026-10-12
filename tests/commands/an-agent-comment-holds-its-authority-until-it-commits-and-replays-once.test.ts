// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent's `task.comment` against the revocations that race it, a crash
// inside it, and the same request sent again. Each racer runs on a connection
// of its own, and each wait is seen in `pg_stat_activity`, never assumed after
// a sleep.
//
// - A `delegation.revoke` that commits while the comment waits for its task
//   refuses the comment, and nothing is written.
// - A `grant.revoke` that arrives once the comment holds its authority waits
//   for the comment to commit; the comment is written once.
// - A comment whose transaction dies at its authority re-check writes nothing,
//   and the same request sent again (its answer lost) writes it once; a third
//   send answers the same comment and writes no second.
// - A comment refused for a grant revoked while it waited is refused again,
//   the same way, when the same request is sent again.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import {
  connect,
  lockAccess,
  mintDelegation,
  revokeGrant,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { holdRow, latch, waiterOf, type Held } from '../support/lock-wait-race.ts';
import { aiWorld, created, type AiWorld } from './ai-assign-world.ts';
import { codeOf, detailOf, type Decider } from './agent-fixture.ts';
import { enrol, grantTo, type Member } from './fixture.ts';

let w: AiWorld;
let manager: Member;
beforeAll(async () => {
  w = await aiWorld('commentholdsauthority');
  manager = await enrol(w.world.db.app, w.world.business, `mgr_${randomUUID().slice(0, 8)}`);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    for (const action of ['manage', 'read', 'write', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one grant at a time, one connection
      await grantTo(tx, manager, action);
    }
  });
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** A backend as a `Held`, so the race helpers can ask who waits on it. */
const backend = (pid: number): Held => ({ pid, letGo: async () => await Promise.resolve() });

const pidOf = async (database: Database): Promise<number> => {
  const [row] = await database.withBusiness(
    w.world.business,
    async (tx) => await tx.query<{ readonly pid: number }>('select pg_backend_pid() as pid'),
  );
  if (row === undefined) throw new Error('no backend id');
  return row.pid;
};

/** A task of a fresh person's, and a live delegation of theirs on it for the world's agent. */
async function delegated(
  name: string,
): Promise<{ person: Decider; task: string; delegationId: string; credential: string }> {
  const person = await w.world.decider(`${name}_${randomUUID().slice(0, 8)}`);
  const task = await created(w, person, name);
  const minted = await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const made = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: person.personId,
      mintedByActorId: person.actorId,
      purpose: `comment_${randomUUID().slice(0, 8)}`,
      collections: ['task'],
      actions: ['read', 'write', 'comment'],
      purposeScope: { kind: 'record', id: task },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!made.ok) throw new Error(made.refusal.code);
    return made.value;
  });
  return { person, task, delegationId: minted.delegation.id, credential: minted.credential };
}

const comment = (task: string, body: string, operationId: string) => ({
  command: 'task.comment',
  operationId,
  recordId: task,
  body,
  audience: 'internal',
});

const bodies = async (body: string): Promise<number> =>
  (
    await w.world.db.admin.execute("select id from public.records where data ->> 'body' = $1", [
      body,
    ])
  ).length;

it('a delegation revoked while an agent comment waits for its task refuses the comment', async () => {
  const { task, delegationId, credential } = await delegated('delegation revoke race');
  const body = `after its delegation was revoked ${randomUUID()}`;
  const held = await holdRow(w.world.db, 'select id from public.records where id = $1 for update', [
    task,
  ]);
  const revoker = connect(w.world.db.appUrl);
  let pending: ReturnType<typeof w.world.asAgent> | undefined;
  try {
    pending = w.world.asAgent(comment(task, body, randomUUID()), credential);
    await waiterOf(w.world.db, held);
    const revoked = await executeCommand(revoker, w.world.business, manager.presented, 'api', {
      command: 'delegation.revoke',
      operationId: randomUUID(),
      delegationId,
    });
    expect(codeOf(revoked), 'the revocation commits while the comment waits').toBe('not-a-refusal');
  } finally {
    await held.letGo();
    await revoker.close();
  }
  expect({ code: codeOf(await pending), written: await bodies(body) }).toEqual({
    code: 'DELEGATION_NOT_LIVE',
    written: 0,
  });
});

// oxlint-disable-next-line max-lines-per-function -- the held delegation, both racers and the order they commit in
it('a grant revoke that arrives once an agent comment holds its authority waits for the comment to commit', async () => {
  const { person, task, delegationId, credential } = await delegated('revoke after the hold');
  const body = `before its grant was revoked ${randomUUID()}`;
  const agentPid = await pidOf(w.world.db.app);
  // The comment's last lock wait: the delegation, asked again after the grants and the task.
  const held = await holdRow(
    w.world.db,
    'select id from public.delegations where id = $1 for update',
    [delegationId],
  );
  const revoker = connect(w.world.db.appUrl);
  const revokerPid = await pidOf(revoker);
  let pending: ReturnType<typeof w.world.asAgent> | undefined;
  let revoking: ReturnType<typeof executeCommand> | undefined;
  let revokeWaitedOnComment = false;
  try {
    pending = w.world.asAgent(comment(task, body, randomUUID()), credential);
    await waiterOf(w.world.db, held);
    revoking = executeCommand(revoker, w.world.business, manager.presented, 'api', {
      command: 'grant.revoke',
      operationId: randomUUID(),
      grantId: person.grants.comment,
    });
    await waiterOf(w.world.db, backend(agentPid));
    const [waits] = await w.world.db.admin.execute<{ readonly on: boolean }>(
      'select $2::int = any(pg_blocking_pids($1)) as on',
      [revokerPid, agentPid],
    );
    revokeWaitedOnComment = waits?.on === true;
  } finally {
    await held.letGo();
    await Promise.allSettled([pending, revoking]);
    await revoker.close();
  }
  expect({
    revokeWaitedOnComment,
    comment: codeOf(await pending),
    revoke: codeOf(await revoking),
    written: await bodies(body),
  }).toEqual({
    revokeWaitedOnComment: true,
    comment: 'not-a-refusal',
    revoke: 'not-a-refusal',
    written: 1,
  });
});

/** The app database, but the transaction that reaches the comment's authority re-check dies there. */
function diesAtTheRecheck(app: Database): { database: Database; died: () => boolean } {
  let died = false;
  const database: Database = {
    ...app,
    withBusiness: async (business, run) =>
      await app.withBusiness(business, async (tx) => {
        const dying: typeof tx = {
          ...tx,
          query: async <Row>(text: string, parameters?: readonly unknown[]) => {
            if (
              !died &&
              /from public\.delegations[\s\S]*any\(\$2::uuid\[\]\)[\s\S]*for share/u.test(text)
            ) {
              died = true;
              throw new Error('the process died at the re-check');
            }
            return await tx.query<Row>(text, parameters);
          },
        };
        return await run(dying);
      }),
  };
  return { database, died: () => died };
}

it('an agent comment whose transaction dies at its authority re-check writes nothing, and its resend writes it once', async () => {
  const { task, credential } = await delegated('crash at the re-check');
  const body = `sent again after a crash ${randomUUID()}`;
  const operationId = randomUUID();
  const dying = diesAtTheRecheck(w.world.db.app);
  const crashed = await executeAgentCommand(
    dying.database,
    w.world.business,
    { provider: 'supabase', subject: w.world.agentSubject() },
    credential,
    comment(task, body, operationId) as never,
  ).then(
    () => 'answered',
    (cause: unknown) => cause,
  );
  expect({ died: dying.died(), crashed, written: await bodies(body) }).toEqual({
    died: true,
    crashed: new Error('the process died at the re-check'),
    written: 0,
  });
  // The answer was lost: the same request again, then once more.
  const resent = await w.world.asAgent(comment(task, body, operationId), credential);
  const replayed = await w.world.asAgent(comment(task, body, operationId), credential);
  expect({
    resent: codeOf(resent),
    replayed: codeOf(replayed),
    same: detailOf(replayed)['commentId'] === detailOf(resent)['commentId'],
    written: await bodies(body),
  }).toEqual({ resent: 'not-a-refusal', replayed: 'not-a-refusal', same: true, written: 1 });
});

// oxlint-disable-next-line max-lines-per-function -- the held grant, the revoke, the refusal and its resend
it('an agent comment refused for a grant revoked while it waited is refused again when sent again', async () => {
  const { person, task, credential } = await delegated('refused and sent again');
  const body = `refused then resent ${randomUUID()}`;
  const operationId = randomUUID();
  const revoker = connect(w.world.db.appUrl);
  const revokerPid = await pidOf(revoker);
  const released = latch();
  const locked = latch();
  // A revocation as `grant.revoke` makes one: the access lock, the grant row, then the write.
  const revoking = revoker.withBusiness(w.world.business, async (tx) => {
    await lockAccess(tx);
    await tx.query('select id from public.grants where business_id = $1 and id = $2 for update', [
      tx.businessId,
      person.grants.comment,
    ]);
    locked.open();
    await released.promise;
    await revokeGrant(tx, person.grants.comment);
  });
  let pending: ReturnType<typeof w.world.asAgent> | undefined;
  try {
    await locked.promise;
    pending = w.world.asAgent(comment(task, body, operationId), credential);
    await waiterOf(w.world.db, backend(revokerPid));
  } finally {
    released.open();
    await Promise.allSettled([revoking, pending]);
    await revoker.close();
  }
  await revoking;
  const first = await pending;
  const again = await w.world.asAgent(comment(task, body, operationId), credential);
  expect({ first: codeOf(first), again: codeOf(again), written: await bodies(body) }).toEqual({
    first: 'DELEGATION_NARROWED',
    again: 'DELEGATION_NARROWED',
    written: 0,
  });
});
