// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may read an activation's history, through the real route. It is
// `settings:read` at the business, as the registry is: a holder of it reads
// the history, a holder of it at one client's scope only or of no settings key
// is refused, and an agent under a live delegation is refused by name, as it
// is the registry. Two businesses: bravo's activation, its occurrences and
// its changes never reach alpha's answer, and bravo's activation id sent from
// alpha is answered exactly as a fabricated one, naming no id.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimOccurrence } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { Answer } from '../api/fixture.ts';
import { createRegistryWorld, type RegistryWorld } from './registry-world.ts';
import { applied, askHistory, historyPage, scheduledOnFirst } from './history-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The answer as a caller sees it, less the attempt identity each request mints. */
const seen = (answer: Answer): unknown => {
  const { operationId: _attempt, ...body } = answer.body;
  return [answer.status, body];
};

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('who reads an activation history', () => {
  let w: RegistryWorld;
  let activationId: string;
  /** Every answer alpha's callers got. */
  const alphaAnswers: Answer[] = [];

  beforeAll(async () => {
    w = await createRegistryWorld('ahwho');
    ({ activationId } = await scheduledOnFirst(w));
    // Bravo's activation gets an occurrence of each cause and a change of its
    // own, the event's id carrying bravo's canary.
    const bravo = w.bravoRows.activationId;
    const { db } = w.controls.fixture;
    await db.app.withBusiness(w.bravo, async (tx) => {
      const claim = await claimOccurrence(tx, bravo, { dueAt: new Date(Date.UTC(2026, 10, 4)) });
      expect(claim.kind).toBe('claimed');
    });
    await db.admin.execute(
      `insert into public.activation_occurrences
         (business_id, id, activation_id, version_id, event_id, outcome)
       values ($1, gen_random_uuid(), $2, $3, $4, 'no_standing_approval')`,
      [w.bravo, bravo, w.bravoRows.versionId, w.bravoCanary],
    );
    const off = await w.as(
      w.bravoAdmin,
      'activation.turn_off',
      { activationId: bravo, expectedRevision: 1 },
      'bravo',
    );
    expect(off.status, JSON.stringify(off.body)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  const asAlpha = async (
    who: Parameters<typeof askHistory>[1],
    id: unknown,
    cursor?: string,
  ): Promise<Answer> => {
    const answer = await askHistory(w, who, id, cursor);
    alphaAnswers.push(answer);
    return answer;
  };

  it('answers a holder of settings:read and refuses a caller without it at the business', async () => {
    for (const who of [w.admin, w.reader, w.settingsOnly, w.automationOnly]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const answer = await asAlpha(who, activationId);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect((answer.body['entries'] as unknown[]).length).toBeGreaterThan(0);
    }
    for (const who of [w.clientManager, w.plain]) {
      // eslint-disable-next-line no-await-in-loop -- one caller at a time
      const answer = await asAlpha(who, activationId);
      expect([answer.status, answer.body['code']], who.actorId).toStrictEqual([
        403,
        'SCOPE_NOT_GRANTED',
      ]);
      expect(answer.body['entries']).toBeUndefined();
    }
  });

  it('refuses an agent under a live delegation by name, as it refuses the registry', async () => {
    const task = await w.controls.createTask('agent asks a history');
    const proposal = await w.controls.propose(task.id, task.revision);
    const picked = await w.controls.pickup(await w.controls.approve(proposal));
    const credential = String(picked['credential']);
    for (const name of ['automation.registry', 'automation.history']) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const answer = await w.controls.asAgent(name, { activationId }, credential);
      alphaAnswers.push(answer);
      expect([answer.status, answer.body['code'], answer.body['names']], name).toStrictEqual([
        403,
        'DELEGATION_EXCLUDES_OPERATION',
        [name],
      ]);
      expect(answer.body['entries']).toBeUndefined();
    }
  });

  it("never sends bravo's activation, occurrences or changes to alpha, and answers its id as a fabricated one", async () => {
    // Bravo reads its own: the rows are there to leak.
    const theirs = await historyPage(w, w.bravoAdmin, w.bravoRows.activationId, undefined, 'bravo');
    const theirIds = theirs.entries.map((entry) => entry.id);
    expect(theirs.entries.map((entry) => entry.kind).toSorted()).toStrictEqual([
      'change',
      'change',
      'occurrence',
      'occurrence',
    ]);
    const crossed = await asAlpha(w.admin, w.bravoRows.activationId);
    const made = await asAlpha(w.admin, randomUUID());
    expect([crossed.status, crossed.body['code'], crossed.body['names']]).toStrictEqual([
      404,
      'NOT_FOUND',
      ['activationId'],
    ]);
    expect(seen(crossed)).toStrictEqual(seen(made));
    const notAnId = await asAlpha(w.admin, 'not-an-activation');
    expect(seen(notAnId)).toStrictEqual(seen(made));
    expect(JSON.stringify(crossed.body)).not.toContain(w.bravoRows.activationId);
    const ours = await historyPage(w, w.admin, activationId);
    alphaAnswers.push({ status: 200, body: { ...ours } });
    const ourIds = new Set(ours.entries.map((entry) => entry.id));
    for (const id of theirIds) expect(ourIds.has(id)).toBe(false);
    // Not even bravo is sent the event id carrying its canary.
    expect(JSON.stringify(theirs)).not.toContain(w.bravoCanary);
    for (const answer of alphaAnswers) {
      const said = JSON.stringify(answer.body);
      expect(said).not.toContain(w.bravoCanary);
      expect(said).not.toContain(w.bravoRows.activationId);
      for (const id of theirIds) expect(said).not.toContain(id);
    }
  });

  it('shows another business nothing of alpha either, its activation answered as unknown', async () => {
    const asked = await askHistory(w, w.bravoAdmin, activationId, undefined, 'bravo');
    const made = await askHistory(w, w.bravoAdmin, randomUUID(), undefined, 'bravo');
    expect(seen(asked)).toStrictEqual(seen(made));
    expect(JSON.stringify(asked.body)).not.toContain(activationId);
    expect(JSON.stringify(asked.body)).not.toContain(w.canary);
    await applied(w, 'activation.turn_off', { activationId, expectedRevision: 1 });
    const still = await historyPage(w, w.bravoAdmin, w.bravoRows.activationId, undefined, 'bravo');
    expect(still.entries).toHaveLength(4);
  });
});
