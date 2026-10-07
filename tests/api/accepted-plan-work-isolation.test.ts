// SPDX-License-Identifier: AGPL-3.0-only
//
// PRV-oa-1111 finding 2: the `plan_records` half of a conversation's work
// (`conversation-work.ts`) across the three crossings, every plan accepted
// through `task.accept_plan` with its owner's conversationId, each
// conversation wrapped by `writeWrapUp` and held by the purge's own answer.
// Run and gate ids are fresh per plan, so each is a canary.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeConversation, writeWrapUp } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { addClient, enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  CONVERSATION,
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { createControls, detailOf, type Controls } from './controls-fixture.ts';
import type { Answer } from './fixture.ts';
import { acceptBody, conversationOf, useInstructionRoot } from '../runtime/aw-04-world.ts';
import {
  appliedDetail,
  asPerson as asBravo,
  createTask as createBravoTask,
  freshPurpose,
  propose as proposeInBravo,
  seedSchedules,
  type Schedules,
} from '../runtime/schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Accepted {
  readonly taskId: string;
  readonly runId: string;
  readonly gateId: string;
}

interface ServedWrapUp {
  readonly items: readonly {
    readonly key: string;
    readonly fact: string;
    readonly pointers: readonly { readonly id: string }[];
  }[];
  readonly leftOpen: readonly { readonly id: string }[];
}

const idsOf = (plan: Accepted): readonly string[] => [plan.runId, plan.gateId];

// eslint-disable-next-line max-lines-per-function -- one world, one case per crossing
describe.skipIf(serverUrl === undefined)('accepted-plan work across the crossings', () => {
  useInstructionRoot();
  let c: Controls;
  let w: ConversationWorld;
  let bravo: Schedules;
  let ownerB: Member;
  let clientXReader: Member;
  // A's `mixed` holds X's and Y's plans, B's `theirs` B's; `empty` nothing.
  let mixed: string;
  let empty: string;
  let theirs: string;
  let bravoConversation: string;
  let onX: Accepted;
  let onY: Accepted;
  let byB: Accepted;
  let inBravo: Accepted;

  const alpha = (): Database => w.fixture.db.app;
  const wrapIn = async (business: string, conversationId: string) =>
    await alpha().withBusiness(
      business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: 'prv1111' }),
    );
  const purgeIn = async (business: string, conversationId: string) =>
    await alpha().withBusiness(
      business,
      async (tx) => await purgeConversation(tx, { conversationId, operationId: randomUUID() }),
    );
  /** The stored wrap-up, as the worker wrote it, read through the business's own connection. */
  const storedIn = async (business: string, conversationId: string): Promise<string> =>
    await alpha().withBusiness(business, async (tx) => {
      const rows = await tx.query<{ items: unknown; left_open: unknown }>(
        `select items, left_open from public.conversation_wrap_ups
          where business_id = $1 and conversation_id = $2 order by version desc limit 1`,
        [business, conversationId],
      );
      expect(rows, `a wrap-up for ${conversationId}`).toHaveLength(1);
      return JSON.stringify(rows[0]);
    });
  const read = async (member: Member, conversationId: string): Promise<Answer> =>
    await w.as(member, 'conversation.read', { conversationId });

  /** A task of client `clientId`'s in Alpha with a plan proposed on it. */
  async function plannedFor(clientId: string, title: string) {
    const created = await c.createTask(title);
    const before = await w.as(w.owner, 'task.read', { recordId: created.id });
    const party = await w.as(w.owner, 'task.set_party', {
      operationId: randomUUID(),
      recordId: created.id,
      expectedRevision: (before.body['task'] as { revision: number }).revision,
      fields: { client: clientId },
    });
    expect(party.status, JSON.stringify(party.body)).toBe(200);
    const after = await w.as(w.owner, 'task.read', { recordId: created.id });
    const revision = (after.body['task'] as { revision: number }).revision;
    return { taskId: created.id, proposal: await c.propose(created.id, revision, freshPurpose()) };
  }

  async function acceptedInAlpha(
    who: Member,
    plan: Awaited<ReturnType<typeof plannedFor>>,
    conversationId: string,
  ): Promise<Accepted> {
    const answer = await c.asPerson('task.accept_plan', acceptBody(plan, { conversationId }), who);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return {
      taskId: plan.taskId,
      runId: String(detailOf(answer)['runId']),
      gateId: String(plan.proposal['gateId']),
    };
  }

  /** Bravo's owner accepts a plan of their own in their own conversation. */
  async function acceptedInBravo(conversationId: string): Promise<Accepted> {
    const taskId = await createBravoTask(bravo, `bravo canary ${randomUUID()}`);
    const proposal = await proposeInBravo(bravo, taskId, {
      maximumMinor: 1_000,
      purpose: freshPurpose(),
    });
    const detail = appliedDetail(
      await asBravo(bravo, acceptBody({ taskId, proposal }, { conversationId })),
      'task.accept_plan',
    );
    return { taskId, runId: String(detail['runId']), gateId: String(proposal['gateId']) };
  }

  /** A's two conversations, B's, and Bravo's owner's with a first message of its own. */
  async function startConversations(): Promise<void> {
    mixed = await started(w, w.owner, { body: 'Plan the client work' });
    empty = await started(w, w.owner, { body: 'Nothing accepted here' });
    theirs = await started(w, ownerB, { body: 'Plan my own work' });
    bravoConversation = await conversationOf(bravo, bravo.decider);
    await alpha().withBusiness(bravo.business, async (tx) => {
      await tx.query(
        `insert into public.conversation_messages
           (business_id, id, conversation_id, role, author_actor_id, body)
         values ($1, $2, $3, 'person', $4, 'Bravo plans its own work')`,
        [bravo.business, randomUUID(), bravoConversation, bravo.decider.actorId],
      );
    });
  }

  /** Every conversation eight days quiet, then wrapped by the worker in its own business. */
  async function ageAndWrapAll(): Promise<void> {
    for (const id of [mixed, empty, theirs, bravoConversation]) {
      // eslint-disable-next-line no-await-in-loop -- one conversation at a time
      await w.age(id, 8);
    }
    for (const [business, id] of [
      [w.fixture.business, mixed],
      [w.fixture.business, empty],
      [w.fixture.business, theirs],
      [bravo.business, bravoConversation],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one wrap-up at a time
      expect(await wrapIn(business, id)).toMatchObject({ ok: true, written: true });
    }
  }

  beforeAll(async () => {
    c = await createControls('prv1111_iso');
    w = await conversationWorld(c);
    process.env['GATE_SIGNING_KEY_ID'] = 'test/prv1111-bravo@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    bravo = await seedSchedules(w.fixture.db, 'prv1111-bravo', 1_000_000);
    ownerB = w.colleague;
    clientXReader = await enrol(alpha(), w.fixture.business, 'client_x_reader');
    const [clientX, clientY] = [randomUUID(), randomUUID()];
    await addClient(alpha(), w.fixture.business, clientX, w.owner);
    await addClient(alpha(), w.fixture.business, clientY, w.owner);
    await alpha().withBusiness(w.fixture.business, async (tx) => {
      await setConversationWindow(tx, 7);
      await grantTo(tx, w.owner, 'share');
      // B decides plans of their own; neither A nor B holds conversation:read.
      await grantTo(tx, ownerB, 'decide');
    });
    await alpha().withBusiness(bravo.business, async (tx) => {
      await installBusinessSettings(tx);
      await setConversationWindow(tx, 7);
    });

    await startConversations();

    const planX = await plannedFor(clientX, `client X task ${randomUUID()}`);
    const planY = await plannedFor(clientY, `client Y canary ${randomUUID()}`);
    const planB = await plannedFor(clientX, `owner B task ${randomUUID()}`);
    onX = await acceptedInAlpha(w.owner, planX, mixed);
    onY = await acceptedInAlpha(w.owner, planY, mixed);
    byB = await acceptedInAlpha(ownerB, planB, theirs);
    inBravo = await acceptedInBravo(bravoConversation);

    await alpha().withBusiness(w.fixture.business, async (tx) => {
      await grantTo(tx, clientXReader, 'read', { kind: 'business', id: null }, false, CONVERSATION);
      await grantTo(tx, clientXReader, 'read', { kind: 'record', id: onX.taskId });
    });
    await ageAndWrapAll();
  }, 240_000);

  afterAll(async () => {
    await w?.drop();
  });

  it("business-to-business: Bravo's accepted plans never reach Alpha's work list or hold, nor Alpha's Bravo's", async () => {
    const alphaMixed = await storedIn(w.fixture.business, mixed);
    const alphaEmpty = await storedIn(w.fixture.business, empty);
    const bravoOwn = await storedIn(bravo.business, bravoConversation);
    for (const id of idsOf(inBravo)) {
      expect(alphaMixed).not.toContain(id);
      expect(alphaEmpty).not.toContain(id);
    }
    for (const id of [...idsOf(onX), ...idsOf(onY), ...idsOf(byB)]) {
      expect(bravoOwn).not.toContain(id);
    }
    // Positive controls: each business's own accepted plans are its work.
    for (const id of idsOf(inBravo)) expect(bravoOwn).toContain(id);
    for (const id of [...idsOf(onX), ...idsOf(onY)]) expect(alphaMixed).toContain(id);
    // Bravo's planned run holds Bravo's body and never Alpha's: Alpha's
    // conversation with no work of its own purges; Bravo's is held open.
    expect(await purgeIn(bravo.business, bravoConversation)).toEqual({
      ok: false,
      code: 'WORK_OPEN',
    });
    expect(await purgeIn(w.fixture.business, empty)).toMatchObject({ ok: true, replayed: false });
    // Bravo's owner reaches nothing of Alpha's conversation at Alpha's address.
    const crossed = await w.as(bravo.decider, 'conversation.read', { conversationId: mixed });
    expect(crossed.status).toBeGreaterThanOrEqual(400);
    for (const id of [mixed, ...idsOf(onX), ...idsOf(onY)]) {
      expect(JSON.stringify(crossed.body)).not.toContain(id);
    }
  });

  it("person-to-person: B's accepted plan never shows in A's conversation, and neither owner reads the other's", async () => {
    const own = await read(w.owner, mixed);
    expect(own.status).toBe(200);
    const ownText = JSON.stringify(own.body);
    for (const id of idsOf(byB)) expect(ownText).not.toContain(id);
    for (const id of [...idsOf(onX), ...idsOf(onY)]) expect(ownText).toContain(id);
    const bOwn = await read(ownerB, theirs);
    expect(bOwn.status).toBe(200);
    const bText = JSON.stringify(bOwn.body);
    for (const id of [...idsOf(onX), ...idsOf(onY)]) expect(bText).not.toContain(id);
    for (const id of idsOf(byB)) expect(bText).toContain(id);
    expect(await storedIn(w.fixture.business, mixed)).not.toContain(byB.runId);
    expect(await storedIn(w.fixture.business, theirs)).not.toContain(onX.runId);
    for (const [who, foreign, ids] of [
      [w.owner, theirs, idsOf(byB)],
      [ownerB, mixed, [...idsOf(onX), ...idsOf(onY)]],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const crossed = await read(who, foreign);
      expect(crossed.status).toBe(403);
      expect(crossed.body['code']).toBe('SCOPE_NOT_GRANTED');
      for (const id of ids) expect(JSON.stringify(crossed.body)).not.toContain(id);
    }
  });

  it("client-to-client: a colleague who reads only X's task sees X's run and gate and never Y's ids or counts", async () => {
    const answer = await read(clientXReader, mixed);
    expect(answer.status).toBe(200);
    const text = JSON.stringify(answer.body);
    for (const id of [onY.taskId, ...idsOf(onY)]) expect(text).not.toContain(id);
    const wrapUp = answer.body['wrapUp'] as ServedWrapUp;
    const item = (key: string) => wrapUp.items.find((entry) => entry.key === key);
    // Positive control: X's run and gate pointers reach this reader, counted alone.
    expect({
      runs: item('runs_started')?.pointers.map((pointer) => pointer.id),
      runsFact: item('runs_started')?.fact,
      gates: item('gates_raised')?.pointers.map((pointer) => pointer.id),
      gatesFact: item('gates_raised')?.fact,
      leftOpen: wrapUp.leftOpen.map((pointer) => pointer.id),
    }).toEqual({
      runs: [onX.runId],
      runsFact: '1 runs started',
      gates: [onX.gateId],
      gatesFact: '1 gates raised',
      leftOpen: [onX.runId],
    });
    // The owner, who reads both tasks, sees both.
    const own = await read(w.owner, mixed);
    const ownWrap = own.body['wrapUp'] as ServedWrapUp;
    expect(ownWrap.items.find((entry) => entry.key === 'runs_started')?.fact).toBe(
      '2 runs started',
    );
  });
});
