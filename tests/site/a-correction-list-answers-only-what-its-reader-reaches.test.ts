// SPDX-License-Identifier: AGPL-3.0-only
//
// #1694: `live_correction.list` answers the corrections a reader reaches, to
// draw their cards again after a reload: `run:write` at the correction's own
// party and `task:read` on its task, both judged inside the query. Five real
// crossings, each beside a reader in scope who does see the corrections:
// another business, another client party, a member without read on the task,
// a client outside the business, and an agent under a live delegation (the
// read is never an agent's). No crossing's body carries the planted
// correction's id or version.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { requestBody } from './c80-world.ts';
import { B_FILE, B_PAGE } from './c80-sites.ts';
import { grantTo, shareWithClient } from '../commands/fixture.ts';
import { code, correctionReadsWorld, listed, type ReadsWorld } from './correction-reads-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Correction list: DATABASE_URL is unset.');

let r: ReadsWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) r = await correctionReadsWorld('c80list');
}, 180_000);
afterAll(async () => {
  if (serverUrl !== undefined) await r.w.world.drop();
});

/** A request's overrides for party B's page, under task B. */
const atB = () => ({ partyId: r.w.partyB, taskId: r.w.taskB, pageUrl: B_PAGE, path: B_FILE });

/** The answer carries none of these. */
const carriesNone = (answer: unknown, markers: readonly string[]) => {
  for (const marker of markers) expect(JSON.stringify(answer)).not.toContain(marker);
};

describe.skipIf(serverUrl === undefined)('live_correction.list, in reach', () => {
  it('answers each correction with its task, state and words, newest first', async () => {
    const first = await r.requested(r.w.ava);
    const second = await r.requested(r.w.ava, atB());
    const answer = await r.listAs(r.w.ava);
    expect(code(answer)).toBe('not-a-refusal');
    const ids = listed(answer);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(r.live.id));
    const rows = (answer as unknown as { corrections: readonly Record<string, unknown>[] })
      .corrections;
    expect(rows.find((c) => c['correctionId'] === first.id)).toStrictEqual({
      correctionId: first.id,
      taskId: r.w.taskA,
      state: 'requested',
      approver: null,
      versionId: first.versionId,
      pageUrl: requestBody(r.w.partyA, r.w.taskA)['pageUrl'],
      word: 'friendly',
      replacement: 'welcoming',
      requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
    });
    expect(rows.find((c) => c['correctionId'] === r.live.id)).toMatchObject({
      state: 'live',
      approver: 'ben',
    });
  });
});

describe.skipIf(serverUrl === undefined)('live_correction.list, across a boundary', () => {
  it('another business lists none of this one’s, and this one none of theirs', async () => {
    const ours = await r.requested(r.w.ava);
    const theirs = detailOf(
      await r.w.asIn(r.w.beta, r.w.eve, requestBody(r.w.betaParty, r.w.betaTask)),
    );
    const foreign = await r.listAs(r.w.eve, r.w.beta);
    expect(listed(foreign)).toContain(String(theirs['correctionId']));
    carriesNone(foreign, [ours.id, ours.versionId, r.live.id]);
    expect(listed(await r.listAs(r.w.ava))).not.toContain(String(theirs['correctionId']));
  });

  it('a grant on party B lists party B’s corrections and nothing on party A', async () => {
    const b = await r.requested(r.w.dee, atB());
    const a = await r.requested(r.w.ava);
    const answer = await r.listAs(r.w.dee);
    expect(listed(answer)).toContain(b.id);
    carriesNone(answer, [a.id, a.versionId, r.live.id, r.w.taskA]);
  });

  it('a member without read on a task lists none of that task’s corrections', async () => {
    const b = await r.requested(r.w.ava, atB());
    const a = await r.requested(r.w.ava);
    const answer = await r.listAs(r.hal);
    expect(listed(answer)).toContain(b.id);
    carriesNone(answer, [a.id, a.versionId, r.live.id, r.w.taskA]);
  });
});

describe.skipIf(serverUrl === undefined)('live_correction.list, outside the team', () => {
  it('a client holding run:write at the party lists nothing', async () => {
    const gus = await r.w.world.decider('gus-list');
    const { app } = r.w.world.db;
    await app.withBusiness(r.w.world.business, async (tx) => await grantTo(tx, gus, 'share'));
    const client = await shareWithClient(app, r.w.world.business, gus, r.w.taskA);
    await app.withBusiness(r.w.world.business, async (tx) => {
      await grantTo(tx, client, 'write', { kind: 'party', id: r.w.partyA }, false, 'run');
    });
    expect(await r.listAs(client)).toStrictEqual({ ok: true, corrections: [] });
  });

  it('an agent under a live delegation lists nothing: the read is never an agent’s', async () => {
    const picked = await r.w.pickUpUnder(r.w.ava, 'the about page, listed', r.w.partyA);
    const byAgent = await r.w.world.asAgent(
      { command: 'live_correction.list', operationId: randomUUID() },
      picked.credential,
    );
    expect(codeOf(byAgent)).toBe('DELEGATION_EXCLUDES_OPERATION');
    carriesNone(byAgent, [r.live.id]);
  });

  it('a member holding run:write nowhere is refused', async () => {
    expect(code(await r.listAs(r.w.admin))).toBe('SCOPE_NOT_GRANTED');
  });
});
