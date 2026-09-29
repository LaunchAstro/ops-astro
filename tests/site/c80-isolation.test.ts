// SPDX-License-Identifier: AGPL-3.0-only
//
// C80 isolation and C80 canary (standing gate 9). Three real crossings, each
// with the stored state checked afterwards: another business; another client
// party in the same business; another person under a live delegation. A
// planted canary in a correction's content never reaches a refusal, a list,
// the audit payload or the process's output.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { AFTER, BEFORE, c80World, type C80World } from './c80-world.ts';
import { listCoveredCorrections } from '../../packages/core-records/src/site/live-corrections.ts';
import { subjectsOf } from '../../packages/core-records/src/authority/grants.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('C80 isolation: DATABASE_URL is unset, so nothing ran.');

const CANARY = `canary-${randomUUID()}`;

let w: C80World;
/** A correction on party B, carrying the canary in its content. */
let foreign: { correctionId: string; versionId: string };

const listFor = async (business: string, member: Member) =>
  await w.world.db.app.withBusiness(business, async (tx) =>
    (
      await listCoveredCorrections(
        tx,
        subjectsOf({
          businessId: business,
          loginId: '',
          personId: member.personId,
          actorId: member.actorId,
          roleKey: 'member',
        }),
      )
    ).map((row) => row.id),
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80iso');
  await w.setApprover(w.ben.personId);
  const result = await w.request(w.ava, {
    partyId: w.partyB,
    before: `${BEFORE}${CANARY}\n`,
    after: `${AFTER}${CANARY}\n`,
  });
  expect(codeOf(result)).toBe('not-a-refusal');
  const detail = detailOf(result);
  foreign = {
    correctionId: String(detail['correctionId']),
    versionId: String(detail['versionId']),
  };
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C80 isolation, another business', () => {
  it('never approves, lists or counts a correction of another business', async () => {
    const approve = await w.asIn(w.beta, w.eve, {
      command: 'live_correction.approve',
      correctionId: foreign.correctionId,
      versionId: foreign.versionId,
      decision: 'approve',
    });
    expect(codeOf(approve)).toBe('NOT_FOUND');
    expect(JSON.stringify(approve)).not.toContain(CANARY);
    expect(await listFor(w.beta, w.eve)).toEqual([]);
    expect(await w.stateOf(foreign.correctionId)).toBe('requested');
  });
});

describe.skipIf(serverUrl === undefined)(
  'C80 isolation, another client in the same business',
  () => {
    it('a grant on party B reaches party B and nothing on party A', async () => {
      const own = detailOf(await w.request(w.dee, { partyId: w.partyB }));
      const onA = await w.request(w.dee, { partyId: w.partyA });
      expect(codeOf(onA)).toBe('SCOPE_NOT_GRANTED');
      const onlyA = detailOf(await w.request(w.ava));
      const listed = await listFor(w.world.business, w.dee);
      expect(listed).toContain(String(own['correctionId']));
      expect(listed).not.toContain(String(onlyA['correctionId']));
      const approve = await w.approve(
        w.dee,
        String(onlyA['correctionId']),
        String(onlyA['versionId']),
      );
      expect(codeOf(approve)).toBe('SCOPE_NOT_GRANTED');
      expect(await w.stateOf(String(onlyA['correctionId']))).toBe('requested');
    });
  },
);

describe.skipIf(serverUrl === undefined)(
  'C80 isolation, another person under a live delegation',
  () => {
    it('an agent working another person’s task under a live delegation reaches no correction', async () => {
      const picked = await w.world.pickUp(w.cal, 'someone else’s work');
      const asked = await w.world.asAgent(
        {
          command: 'live_correction.approve',
          operationId: randomUUID(),
          correctionId: foreign.correctionId,
          versionId: foreign.versionId,
          decision: 'approve',
        },
        picked.credential,
      );
      expect(codeOf(asked)).not.toBe('not-a-refusal');
      expect(JSON.stringify(asked)).not.toContain(CANARY);
      expect(await w.stateOf(foreign.correctionId)).toBe('requested');
      const rows = await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where requested_by_actor_id = $1',
        [w.world.agentActorId],
      );
      expect(rows[0]?.n).toBe('0');
    });
  },
);

describe.skipIf(serverUrl === undefined)('C80 canary', () => {
  it('keeps planted content out of refusals, the audit payload and the process output', async () => {
    const written: string[] = [];
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      }),
    );
    try {
      const refusedEnvelope = await w.request(w.ava, {
        before: `${BEFORE}${CANARY}\n`,
        after: `${AFTER}${CANARY}-changed\n`,
      });
      expect(codeOf(refusedEnvelope)).toBe('CHANGE_ENVELOPE_EXCEEDED');
      expect(JSON.stringify(refusedEnvelope)).not.toContain(CANARY);
      const refusedScope = await w.approve(w.dee, foreign.correctionId, foreign.versionId);
      expect(JSON.stringify(refusedScope)).not.toContain(CANARY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(written.join('\n')).not.toContain(CANARY);
    const audit = await w.world.db.admin.execute<{ readonly t: string }>(
      'select row_to_json(a)::text as t from public.audit_events a',
      [],
    );
    expect(audit.length).toBeGreaterThan(0);
    for (const row of audit) expect(row.t).not.toContain(CANARY);
  });
});
