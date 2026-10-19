// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2103): a `review:write` delegation minted for one task opens and captures on that task
// and nowhere wider. Another task of the same client, another client's task and another
// business's task are each refused `DELEGATION_OUT_OF_PURPOSE` for an open and for a capture of
// a revision on them, as a fabricated id is; a stray `recordId` naming the delegated task steers
// neither; a replay under a later delegation for another task gets the refusal, never the stored
// receipt. Nothing is written, and no refusal carries a foreign id or a planted marker.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { ABOUT, B_FILE, B_PAGE, PAGE, c35World, type C35World } from './c35-world.ts';
import { delegateReview, type ReviewDelegation } from './c35-delegated.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C35 delegated reach: DATABASE_URL is unset.');

const MARKER = `planted-${randomUUID()}`;
const TABLES = ['reviews', 'review_revisions', 'review_captures'] as const;

let w: C35World;
let delegated: ReviewDelegation;
/** A second task under task A's client. */
let taskA2: string;
/** A revision on each task the delegation does not reach, opened by its own people. */
let foreign: { readonly sameClient: string; readonly otherClient: string; readonly beta: string };

const revisionOf = async (opened: Promise<Parameters<typeof detailOf>[0]>): Promise<string> => {
  const id = detailOf(await opened)['revisionId'];
  if (typeof id !== 'string') throw new Error('a setup open was refused');
  return id;
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c35reach');
  taskA2 = (await w.pickUpUnder(w.ava, 'Another page of the same client', w.partyA)).taskId;
  const marked = { sourceRevision: MARKER };
  foreign = {
    sameClient: await revisionOf(w.open(w.ava, { taskId: taskA2, ...marked })),
    otherClient: await revisionOf(
      w.open(w.ava, { taskId: w.taskB, pageUrl: B_PAGE, path: B_FILE, ...marked }),
    ),
    beta: await revisionOf(w.open(w.eve, { taskId: w.betaTask, ...marked }, w.beta)),
  };
  delegated = await delegateReview(w, w.ava, w.taskA);
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const counts = async () =>
  await Promise.all(
    [w.world.business, w.beta].flatMap((business) =>
      TABLES.map(async (table) => await w.count(table, business)),
    ),
  );

const asAgent = async (body: Readonly<Record<string, unknown>>, credential: string) =>
  await w.world.asAgent({ operationId: randomUUID(), ...body }, credential);

const openOn = (taskId: string) => ({
  command: 'review.open',
  taskId,
  pageUrl: PAGE,
  path: ABOUT,
  sourceRevision: 'agent-rev',
});

/** Each body naming a task the delegation does not reach, as the agent sends it. */
const everyOtherTask = async (credential: string) => ({
  openSameClient: await asAgent(openOn(taskA2), credential),
  openOtherClient: await asAgent({ ...openOn(w.taskB), pageUrl: B_PAGE, path: B_FILE }, credential),
  openOtherBusiness: await asAgent(openOn(w.betaTask), credential),
  openFabricated: await asAgent(openOn(randomUUID()), credential),
  openSteered: await asAgent(
    { ...openOn(w.taskB), pageUrl: B_PAGE, path: B_FILE, recordId: w.taskA },
    credential,
  ),
  captureSameClient: await asAgent(
    { command: 'review.capture', revisionId: foreign.sameClient },
    credential,
  ),
  captureOtherClient: await asAgent(
    { command: 'review.capture', revisionId: foreign.otherClient },
    credential,
  ),
  captureOtherBusiness: await asAgent(
    { command: 'review.capture', revisionId: foreign.beta },
    credential,
  ),
  captureFabricated: await asAgent(
    { command: 'review.capture', revisionId: randomUUID() },
    credential,
  ),
  captureSteered: await asAgent(
    { command: 'review.capture', revisionId: foreign.otherClient, recordId: w.taskA },
    credential,
  ),
});

describe.skipIf(serverUrl === undefined)('C35 a task-scoped review delegation', () => {
  it('refuses an open or a capture on any task but its own, and writes nothing', async () => {
    const before = await counts();
    const tried = await everyOtherTask(delegated.credential);
    expect(
      Object.fromEntries(Object.entries(tried).map(([name, got]) => [name, codeOf(got)])),
    ).toStrictEqual(
      Object.fromEntries(Object.keys(tried).map((name) => [name, 'DELEGATION_OUT_OF_PURPOSE'])),
    );
    expect(await counts()).toStrictEqual(before);

    const shown = JSON.stringify(Object.values(tried));
    for (const planted of [
      MARKER,
      taskA2,
      w.taskB,
      w.betaTask,
      B_PAGE,
      ...Object.values(foreign),
    ]) {
      expect(shown, 'a refusal shows nothing of the task it refused').not.toContain(planted);
    }
  });

  it('gives a replay under a delegation for another task the refusal, never the receipt', async () => {
    const opened = { ...openOn(w.taskA), operationId: randomUUID() };
    const first = await w.world.asAgent(opened, delegated.credential);
    expect(codeOf(first)).toBe('not-a-refusal');
    const revisionId = detailOf(first)['revisionId'];
    const asked = { command: 'review.capture', operationId: randomUUID(), revisionId };
    expect(codeOf(await w.world.asAgent(asked, delegated.credential))).toBe('not-a-refusal');

    const elsewhere = await delegateReview(w, w.ava, taskA2);
    const replays = [
      await w.world.asAgent(opened, elsewhere.credential),
      await w.world.asAgent(asked, elsewhere.credential),
    ];
    expect(replays.map((one) => codeOf(one))).toStrictEqual([
      'DELEGATION_OUT_OF_PURPOSE',
      'DELEGATION_OUT_OF_PURPOSE',
    ]);
    expect(JSON.stringify(replays)).not.toContain(String(revisionId));
  });
});
