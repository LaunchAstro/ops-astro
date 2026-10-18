// SPDX-License-Identifier: AGPL-3.0-only
//
// #1694: `live_correction.list` and `live_correction.receipts`, the two reads
// a card is drawn again from after a reload. Each answers only what the caller
// reaches: `run:write` at the correction's own party and `task:read` on its
// task, both judged inside the query. Five real crossings, each beside a
// reader in scope who does see the correction: another business, another
// client party in the same business, a member without read on the task, a
// client outside the business, and an agent under another person's live
// delegation (neither read is ever an agent's). A refused receipts read is
// compared byte for byte with the answer to an id that names nothing, and no
// crossing's body carries the planted correction's id, version or marker.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';
import { B_FILE, B_PAGE } from './c80-sites.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  RECEIPT_TEXT_LIMIT,
  recordObservedResult,
} from '../../packages/core-records/src/site/index.ts';
import { enrol, grantTo, shareWithClient, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Correction reads: DATABASE_URL is unset.');

let w: C80World;

type Answer = Awaited<ReturnType<typeof executeRead>>;
const code = (result: Answer): string => (isCommandRefusal(result) ? result.code : 'not-a-refusal');

const listAs = async (member: Member, business = w.world.business) =>
  await executeRead(w.world.db.app, business, member.presented, { read: 'live_correction.list' });

const receiptsAs = async (member: Member, correctionId: unknown, business = w.world.business) =>
  await executeRead(w.world.db.app, business, member.presented, {
    read: 'live_correction.receipts',
    correctionId,
  });

/** The ids a list answered, in its order. */
const listed = (result: Answer): readonly string[] =>
  'corrections' in result
    ? (result.corrections as readonly { readonly correctionId: string }[]).map(
        (c) => c.correctionId,
      )
    : [];

const requested = async (member: Member, overrides: Readonly<Record<string, unknown>> = {}) => {
  const detail = detailOf(await w.request(member, overrides));
  return { id: String(detail['correctionId']), versionId: String(detail['versionId']) };
};

const ok = (result: Awaited<ReturnType<C80World['as']>>) => {
  expect(codeOf(result)).toBe('not-a-refusal');
  return detailOf(result);
};

/** A correction on a task Cal holds under his own lease, approved, then observed live. */
async function published(observations: Readonly<Record<string, unknown>>) {
  const created = await w.as(w.cal, { command: 'task.create', fields: { title: 'About' } });
  const task = created as unknown as { recordId: string; revision: number };
  const shared = await w.as(w.admin, {
    command: 'task.set_party',
    recordId: task.recordId,
    expectedRevision: task.revision,
    fields: { client: w.partyA },
  });
  const proposed = ok(
    await w.as(w.cal, {
      command: 'task.propose',
      recordId: task.recordId,
      expectedRevision: Number((shared as unknown as { revision: number }).revision),
      purpose: `draft_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    }),
  );
  const decided = ok(
    await w.as(w.cal, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'approved for the holder to work',
    }),
  );
  const picked = ok(
    await w.as(w.cal, { command: 'task.pickup', reservationId: decided['reservationId'] }),
  );
  const [lease] = await w.world.db.admin.execute<{ fence: string; holder: string }>(
    'select fence::text as fence, holder_actor_id as holder from public.leases where id = $1',
    [picked['leaseId']],
  );
  if (lease === undefined) throw new Error('no lease');
  const asked = await requested(w.ava, { taskId: task.recordId });
  expect(codeOf(await w.approve(w.ben, asked.id, asked.versionId))).toBe('not-a-refusal');
  const written = await w.world.db.app.withBusiness(w.world.business, async (tx) =>
    recordObservedResult(tx, {
      correctionId: asked.id,
      leaseId: String(picked['leaseId']),
      fence: Number(lease.fence),
      actorId: lease.holder,
      step: 'publish',
      outcome: 'live',
      observations,
    }),
  );
  if (!written.ok) throw new Error(`receipt refused ${written.code}`);
  return { ...asked, taskId: task.recordId, receiptId: written.receiptId };
}

const MARKER = `marker-${randomUUID()}`;
const LONG = `${MARKER} ${'walk beside you '.repeat(800)}`;
let live: Awaited<ReturnType<typeof published>>;
let hal: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80reads');
  await w.setApprover(w.ben.personId);
  live = await published({
    published_revision: { observed: 'commit-0123abc' },
    deployment_id: { observed: 'dpl_live1694' },
    before_capture: { observed: 'We walk alongside you.' },
    after_capture: { observed: LONG },
    refusals_raised: { observed: 'none recorded' },
  });
  // Hal holds run:write across the business and reads task B alone.
  hal = await enrol(w.world.db.app, w.world.business, 'hal');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, hal, 'write', { kind: 'business', id: null }, false, 'run');
    await grantTo(tx, hal, 'read', { kind: 'record', id: w.taskB });
  });
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('live_correction.list', () => {
  it('answers each reachable correction with its task, state and words, newest first', async () => {
    const first = await requested(w.ava);
    const second = await requested(w.ava, {
      partyId: w.partyB,
      taskId: w.taskB,
      pageUrl: B_PAGE,
      path: B_FILE,
    });
    const answer = await listAs(w.ava);
    expect(code(answer)).toBe('not-a-refusal');
    const ids = listed(answer);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(live.id));
    const corrections = (answer as unknown as { corrections: readonly Record<string, unknown>[] })
      .corrections;
    expect(corrections.find((c) => c['correctionId'] === first.id)).toStrictEqual({
      correctionId: first.id,
      taskId: w.taskA,
      state: 'requested',
      approver: null,
      versionId: first.versionId,
      pageUrl: requestBody(w.partyA, w.taskA)['pageUrl'],
      word: 'friendly',
      replacement: 'welcoming',
      requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(corrections.find((c) => c['correctionId'] === live.id)).toMatchObject({
      state: 'live',
      approver: 'ben',
    });
  });

  it('another business lists none of this one’s, and this one none of theirs', async () => {
    const ours = await requested(w.ava);
    const theirs = ok(await w.asIn(w.beta, w.eve, requestBody(w.betaParty, w.betaTask)));
    const foreign = await listAs(w.eve, w.beta);
    expect(listed(foreign)).toContain(String(theirs['correctionId']));
    for (const marker of [ours.id, ours.versionId, live.id]) {
      expect(JSON.stringify(foreign)).not.toContain(marker);
    }
    expect(listed(await listAs(w.ava))).not.toContain(String(theirs['correctionId']));
  });

  it('a grant on party B lists party B’s corrections and nothing on party A', async () => {
    const onB = await requested(w.dee, {
      partyId: w.partyB,
      taskId: w.taskB,
      pageUrl: B_PAGE,
      path: B_FILE,
    });
    const onA = await requested(w.ava);
    const answer = await listAs(w.dee);
    expect(listed(answer)).toContain(onB.id);
    for (const marker of [onA.id, onA.versionId, live.id, w.taskA]) {
      expect(JSON.stringify(answer)).not.toContain(marker);
    }
  });

  it('a member without read on a task lists none of that task’s corrections', async () => {
    const onB = await requested(w.ava, {
      partyId: w.partyB,
      taskId: w.taskB,
      pageUrl: B_PAGE,
      path: B_FILE,
    });
    const onA = await requested(w.ava);
    const answer = await listAs(hal);
    expect(listed(answer)).toContain(onB.id);
    for (const marker of [onA.id, onA.versionId, live.id, w.taskA]) {
      expect(JSON.stringify(answer)).not.toContain(marker);
    }
  });

  it('a client holding run:write at the party lists nothing', async () => {
    const gus = await w.world.decider('gus-list');
    const { app } = w.world.db;
    await app.withBusiness(w.world.business, async (tx) => await grantTo(tx, gus, 'share'));
    const client = await shareWithClient(app, w.world.business, gus, w.taskA);
    await app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, client, 'write', { kind: 'party', id: w.partyA }, false, 'run');
    });
    expect(await listAs(client)).toStrictEqual({ ok: true, corrections: [] });
  });

  it('an agent under a live delegation lists nothing, as the read is never an agent’s', async () => {
    const picked = await w.pickUpUnder(w.ava, 'the about page, listed', w.partyA);
    const listedByAgent = await w.world.asAgent(
      { command: 'live_correction.list', operationId: randomUUID() },
      picked.credential,
    );
    expect(codeOf(listedByAgent)).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(JSON.stringify(listedByAgent)).not.toContain(live.id);
  });

  it('a member holding run:write nowhere is refused', async () => {
    expect(code(await listAs(w.admin))).toBe('SCOPE_NOT_GRANTED');
  });
});

describe.skipIf(serverUrl === undefined)('live_correction.receipts', () => {
  it('answers a published correction’s commit, deployment and captures, clipped to a limit', async () => {
    const answer = await receiptsAs(w.ava, live.id);
    expect(answer).toStrictEqual({
      ok: true,
      correctionId: live.id,
      receipts: [
        {
          receiptId: live.receiptId,
          step: 'publish',
          outcome: 'live',
          recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
          commit: 'commit-0123abc',
          deploymentId: 'dpl_live1694',
          beforeCapture: { text: 'We walk alongside you.', clipped: false },
          afterCapture: { text: LONG.slice(0, RECEIPT_TEXT_LIMIT), clipped: true },
        },
      ],
    });
    expect(LONG.length).toBeGreaterThan(RECEIPT_TEXT_LIMIT);
  });

  it('answers a correction with no receipt yet with an empty list', async () => {
    const asked = await requested(w.ava);
    expect(await receiptsAs(w.ava, asked.id)).toStrictEqual({
      ok: true,
      correctionId: asked.id,
      receipts: [],
    });
  });

  const crossings: readonly [string, () => Promise<[Answer, Answer]>][] = [
    [
      'another business',
      async () => [
        await receiptsAs(w.eve, live.id, w.beta),
        await receiptsAs(w.eve, randomUUID(), w.beta),
      ],
    ],
    [
      'another client party',
      async () => [await receiptsAs(w.dee, live.id), await receiptsAs(w.dee, randomUUID())],
    ],
    [
      'a member without read on the task',
      async () => [await receiptsAs(hal, live.id), await receiptsAs(hal, randomUUID())],
    ],
  ];
  for (const [name, read] of crossings) {
    it(`${name} reads them exactly as an id that names nothing`, async () => {
      const [crossed, unknown] = await read();
      expect(code(crossed)).toBe('NOT_FOUND');
      expect(crossed).toStrictEqual(unknown);
      for (const marker of [live.id, live.versionId, live.receiptId, MARKER]) {
        expect(JSON.stringify(crossed)).not.toContain(marker);
      }
    });
  }

  it('an agent under a live delegation reads none, its own included', async () => {
    const picked = await w.pickUpUnder(w.ava, 'the about page, receipts', w.partyA);
    const ask = async (correctionId: string) =>
      await w.world.asAgent(
        { command: 'live_correction.receipts', operationId: randomUUID(), correctionId },
        picked.credential,
      );
    const onLive = await ask(live.id);
    expect(codeOf(onLive)).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(await ask(randomUUID())).toStrictEqual(onLive);
    expect(JSON.stringify(onLive)).not.toContain(live.id);
  });

  it('a member holding run:write nowhere is refused alike for a real and an unknown id', async () => {
    const real = await receiptsAs(w.admin, live.id);
    expect(code(real)).toBe('SCOPE_NOT_GRANTED');
    expect(real).toStrictEqual(await receiptsAs(w.admin, randomUUID()));
  });

  it('a malformed id is answered as one that names nothing', async () => {
    expect(await receiptsAs(w.ava, 'not-an-id')).toStrictEqual(
      await receiptsAs(w.ava, randomUUID()),
    );
    expect(code(await receiptsAs(w.ava, 42))).toBe('FIELD_VALUE_INVALID');
  });
});
