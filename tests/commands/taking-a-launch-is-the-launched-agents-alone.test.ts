// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.take_launch`: the launched agent, signed in as itself and holding
// nothing, takes its own waiting launch. The take starts it once and hands
// back the launch's derived credential, which then reads the task. A person,
// another agent's launch and a delegation credential are refused and change
// nothing, and another agent's launch is refused in the same words as one that
// does not exist. With no launch named it takes the caller's own open launch. A
// launch that can no longer run is ended at the take, its delegation settled,
// and handed back no credential; an ended launch answers its receipt.
//
// The client slot set under a launch is a privileged database write, the
// defence behind the public rule: once Launch commits, `task.set_party`
// refuses `CLIENT_LOCKED`, which the last case shows through the command.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from './agent-fixture.ts';
import {
  aiWorld,
  assign,
  created,
  launch,
  ownedAgent,
  revisionOf,
  type AiWorld,
} from './ai-assign-world.ts';
import { addClient, grantTo } from './fixture.ts';
import { APPLIED, derivedFor, launchOf, launchedTask, take, takenAs } from './take-launch-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('take launch: DATABASE_URL is unset, so nothing ran.');

let w: AiWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await aiWorld('takelaunch');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** A refusal as the caller reads it, less the operation id it echoes. */
const withoutIdentity = (result: unknown): unknown => {
  const { operationId: _operationId, ...rest } = result as Record<string, unknown>;
  return rest;
};

/** End every open launch of the world's agent, as the database holds them: the setup, not a path under test. */
const endOpenLaunches = async (): Promise<void> => {
  await w.world.db.admin.execute(
    `update public.task_launches set state = 'ended', ended_at = clock_timestamp()
      where agent_actor_id = $1 and state <> 'ended'`,
    [w.world.agentActorId],
  );
};

/** Each case, run only against a database. */
const live = it.skipIf(serverUrl === undefined);

live(
  'the launched agent takes its waiting launch once and is handed the credential that reads the task',
  async () => {
    const task = await launchedTask(w, 'Draft the agenda');
    const before = await launchOf(w, task);

    const answer = await take(w, before.id);
    const after = await launchOf(w, task);
    const credential = await derivedFor(w, before.id);
    const read = await w.world.asAgent(
      { command: 'task.read', operationId: randomUUID(), recordId: task },
      String(takenAs(answer)['credential']),
    );

    expect({
      code: codeOf(answer),
      detail: takenAs(answer),
      state: after.state,
      takenFor: after.takenFor,
      read: codeOf(read),
    }).toStrictEqual({
      code: APPLIED,
      detail: { launchId: before.id, taskId: task, state: 'started', credential },
      state: 'started',
      takenFor: 'answer',
      read: APPLIED,
    });
  },
);

live(
  'a person, another agent’s launch and a delegation credential are refused, and the launch is as it was',
  async () => {
    const mine = await launchedTask(w, 'Mine to take');
    const theirs = await created(w, w.p, 'Held by another agent');
    expect(codeOf(await assign(w, w.p, theirs, { agent: await ownedAgent(w, w.p) }))).toBe(APPLIED);
    expect(await launch(w, w.p, theirs)).toBe(APPLIED);
    const own = await launchOf(w, mine);
    const other = await launchOf(w, theirs);

    const byPerson = await w.world.asPerson(w.p, {
      command: 'task.take_launch',
      operationId: randomUUID(),
      launchId: own.id,
    });
    const anothers = await take(w, other.id);
    const fabricated = await take(w, randomUUID());
    const underCredential = await take(w, own.id, await derivedFor(w, own.id));

    expect({
      person: codeOf(byPerson),
      another: codeOf(anothers),
      credential: codeOf(underCredential),
      own: await launchOf(w, mine),
      other: await launchOf(w, theirs),
    }).toStrictEqual({
      person: 'SCOPE_NOT_GRANTED',
      another: 'SCOPE_NOT_GRANTED',
      credential: 'SCOPE_NOT_GRANTED',
      own,
      other,
    });
    // Another agent's launch and one that does not exist are refused in the same words.
    expect(withoutIdentity(anothers)).toStrictEqual(withoutIdentity(fabricated));
  },
);

live(
  'with no launch named it takes the caller’s own open launch, and none when it has none',
  async () => {
    await endOpenLaunches();
    const elsewhere = await created(w, w.p, 'Another agent’s, launched first');
    expect(codeOf(await assign(w, w.p, elsewhere, { agent: await ownedAgent(w, w.p) }))).toBe(
      APPLIED,
    );
    expect(await launch(w, w.p, elsewhere)).toBe(APPLIED);
    const task = await launchedTask(w, 'The caller’s own');
    const own = await launchOf(w, task);

    const named = takenAs(await take(w));
    await endOpenLaunches();
    const none = takenAs(await take(w));

    expect({ launchId: named['launchId'], state: named['state'], none }).toStrictEqual({
      launchId: own.id,
      state: 'started',
      none: { state: 'none' },
    });
    expect((await launchOf(w, elsewhere)).state).toBe('waiting');
  },
);

live(
  'a revoked launch is ended at the take with no credential, and then answers its receipt',
  async () => {
    const task = await launchedTask(w, 'Revoked before the take');
    const launched = await launchOf(w, task);
    await w.world.db.admin.execute(
      'update public.delegations set revoked_at = now() where id = $1',
      [launched.delegationId],
    );

    const ended = takenAs(await take(w, launched.id));
    const receipt = takenAs(await take(w, launched.id));

    expect({ ended, receipt, state: (await launchOf(w, task)).state }).toStrictEqual({
      ended: { launchId: launched.id, taskId: task, state: 'ended', cause: 'revoked' },
      receipt: { launchId: launched.id, taskId: task, state: 'ended', cause: 'revoked' },
      state: 'ended',
    });
  },
);

live(
  'a client slot set under the launch ends it at the take, settles its delegation and hands back no credential',
  async () => {
    const task = await launchedTask(w, 'Put under a client by the database');
    const launched = await launchOf(w, task);
    await w.world.db.admin.execute(
      `update public.records set uuid_7 = $2::uuid,
            data = data || jsonb_build_object('client', $2::text) where id = $1`,
      [task, randomUUID()],
    );

    const answer = takenAs(await take(w, launched.id));
    const after = await launchOf(w, task);

    expect({ answer, state: after.state, settled: after.settled }).toStrictEqual({
      answer: { launchId: launched.id, taskId: task, state: 'ended', cause: 'client' },
      state: 'ended',
      settled: true,
    });
  },
);

live('a launched task refuses a client link through the public command', async () => {
  const task = await launchedTask(w, 'Launched, then offered to a client');
  const client = randomUUID();
  await addClient(w.world.db.app, w.world.business, client, w.p);
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.p, 'share');
  });

  const linked = await w.world.asPerson(w.p, {
    command: 'task.set_party',
    operationId: randomUUID(),
    recordId: task,
    expectedRevision: await revisionOf(w, task),
    fields: { client },
  });
  const [slot] = await w.world.db.admin.execute<{ readonly client: string | null }>(
    'select uuid_7::text as client from public.records where id = $1',
    [task],
  );

  expect({ code: codeOf(linked), client: slot?.client }).toStrictEqual({
    code: 'CLIENT_LOCKED',
    client: null,
  });
});
