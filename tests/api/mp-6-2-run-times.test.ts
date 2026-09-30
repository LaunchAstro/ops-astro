// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-2's hero time cell, its read half: `task.read`'s proposal versions
// carry their run's start (its first `claimed` event) and end (a `handed_back`
// event with no claim after it), from `run_events` in this business and on
// this run, through the real boundary and a fresh Postgres. The event rows,
// read as admin, are the oracle. The crossings: another business, another
// client in the same business, and the agent under a live delegation on
// another task, each refused with no time in any body.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentPath, createControls, type Controls } from './controls-fixture.ts';
import { authorised, post, tokenFor, type Answer } from './fixture.ts';
import { pickedUpOn } from './mp-6-1-checks-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Times {
  readonly startedAt: string | null;
  readonly endedAt: string | null;
}

// eslint-disable-next-line max-lines-per-function -- one world, the times and each crossing on it
describe.skipIf(serverUrl === undefined)('MP-6-2 run times', () => {
  let c: Controls;
  let taskId = '';
  let versionId = '';
  let lease = { leaseId: '', fence: 0, credential: '' };

  const timesOf = (answer: Answer): Times | undefined => {
    const proposals = (answer.body['task'] as { proposals: unknown }).proposals as readonly {
      readonly versions: readonly (Times & { readonly versionId: string })[];
    }[];
    const found = proposals.flatMap((p) => p.versions).find((v) => v.versionId === versionId);
    return found === undefined ? undefined : { startedAt: found.startedAt, endedAt: found.endedAt };
  };
  const eventAt = async (kind: string): Promise<string> => {
    const [row] = await c.fixture.db.admin.execute<{ readonly at: Date }>(
      `select created_at as at from public.run_events where task_id = $1 and kind = $2`,
      [taskId, kind],
    );
    return new Date(String(row?.at)).toISOString();
  };

  beforeAll(async () => {
    c = await createControls('mp_6_2_run_times');
    const task = await c.createTask('a task whose run is timed');
    const proposal = await c.propose(task.id, task.revision, 'timed_run');
    taskId = task.id;
    versionId = String(proposal['versionId']);
    const reservationId = await c.approve(proposal);
    const picked = await c.pickup(reservationId, 600);
    lease = {
      leaseId: String(picked['leaseId']),
      fence: Number(picked['fence']),
      credential: String(picked['credential']),
    };
  }, 180_000);

  afterAll(async () => await c?.drop());

  it('MP-6-2 run times: a run started is read with its start and no end, and a run handed back with both', async () => {
    const running = timesOf(await c.asPerson('task.read', { recordId: taskId }));
    expect(running).toStrictEqual({ startedAt: await eventAt('claimed'), endedAt: null });
    const handedBack = await c.asAgent(
      'task.handback',
      { ...lease, outcome: 'completed', report: { wrote: 'a timed draft' } },
      lease.credential,
    );
    expect(handedBack.status).toBe(200);
    const done = timesOf(await c.asPerson('task.read', { recordId: taskId }));
    expect(done).toStrictEqual({
      startedAt: await eventAt('claimed'),
      endedAt: await eventAt('handed_back'),
    });
  });

  it('MP-6-2 run times: a version with no run reads neither time', async () => {
    const task = await c.createTask('a task proposed, never picked up');
    const proposal = await c.propose(task.id, task.revision, 'untimed_run');
    const read = await c.asPerson('task.read', { recordId: task.id });
    const proposals = (read.body['task'] as { proposals: unknown }).proposals as readonly {
      readonly versions: readonly (Times & { readonly versionId: string })[];
    }[];
    const version = proposals
      .flatMap((p) => p.versions)
      .find((v) => v.versionId === String(proposal['versionId']));
    expect(version).toMatchObject({ startedAt: null, endedAt: null });
  });

  it('MP-6-2 run times isolation: another business, another client and the agent on another task read no time of this run', async () => {
    const { db, business } = c.fixture;
    const started = await eventAt('claimed');
    const carriesNothing = (answer: Answer): void => {
      expect(answer.status).toBeGreaterThanOrEqual(400);
      const text = JSON.stringify(answer.body);
      expect(text).not.toContain(started);
      expect(text).not.toContain(versionId);
    };
    // Another business: a reader of all of Bravo names this task, as a made-up id.
    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    const bravoReader: Member = await enrol(db.app, bravo, 'bravo-reader');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoReader, 'read');
    });
    const token = authorised(await tokenFor(bravoReader.presented.subject));
    const across = await post(c.api, '/api/b/bravo/task/read', { recordId: taskId }, token);
    const madeUp = await post(c.api, '/api/b/bravo/task/read', { recordId: randomUUID() }, token);
    expect(across.status).toBe(404);
    expect(across.body).toEqual(madeUp.body);
    carriesNothing(across);
    // Another client in the same business, reading only its own task.
    const other = await c.createTask('another client’s task');
    const otherClient: Member = await enrol(db.app, business, 'other-client');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, otherClient, 'read', { kind: 'record', id: other.id });
    });
    carriesNothing(await c.asPerson('task.read', { recordId: taskId }, otherClient));
    // The agent under a live delegation on another task.
    const sibling = await pickedUpOn(c, 'sibling_run');
    const agent = await post(
      c.api,
      agentPath('task.read'),
      { recordId: taskId },
      {
        ...authorised(await tokenFor(c.fixture.agent.subject)),
        'x-agent-delegation': sibling.credential,
      },
    );
    carriesNothing(agent);
  });
});
