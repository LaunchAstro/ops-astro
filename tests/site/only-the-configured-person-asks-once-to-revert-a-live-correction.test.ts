// SPDX-License-Identifier: AGPL-3.0-only
//
// Asking to revert a live correction (`live_correction.revert`): the
// configured approver's alone, a staff member whose gate grant reaches the
// correction's client, never the requester, only while the correction is
// live, and once. The ask is one stored row whose id the revert step later
// names; a replay of the same operation is answered as the first. Refusals
// store nothing and leave the correction live.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { c80World, type C80World } from './c80-world.ts';
import {
  approved,
  asksOn,
  live,
  moveTo,
  requested,
  revertBody,
  type Asked,
} from './revert-ask-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('Revert ask: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c80World('revertask');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});
beforeEach(async () => {
  if (serverUrl !== undefined) await w.setApprover(w.ben.personId);
});

const askAs = async (member: C80World['ben'], asked: Asked) =>
  await w.as(member, revertBody(asked.correctionId));

/** The ask refused with `code`, nothing stored and the correction where it was. */
async function refusedWith(
  member: C80World['ben'],
  asked: Asked,
  code: string,
  state = 'live',
): Promise<void> {
  expect(codeOf(await askAs(member, asked))).toBe(code);
  expect(await asksOn(w, asked.correctionId)).toEqual([]);
  expect(await w.stateOf(asked.correctionId)).toBe(state);
}

describe.skipIf(serverUrl === undefined)('asking to revert a live correction', () => {
  it('stores one ask by the configured approver, its id the one the answer names', async () => {
    const asked = await live(w);
    const answer = await askAs(w.ben, asked);
    expect(codeOf(answer)).toBe('not-a-refusal');
    const detail = detailOf(answer);
    expect(detail['correctionId']).toBe(asked.correctionId);
    expect(await asksOn(w, asked.correctionId)).toEqual([
      { id: detail['revertAskId'], askedByPersonId: w.ben.personId },
    ]);
    expect(await w.stateOf(asked.correctionId)).toBe('live');
  });

  it('refuses a second ask on the same correction and keeps the first alone', async () => {
    const asked = await live(w);
    const first = detailOf(await askAs(w.ben, asked));
    expect(codeOf(await askAs(w.ben, asked))).toBe('GATE_ALREADY_DECIDED');
    expect(await asksOn(w, asked.correctionId)).toEqual([
      { id: first['revertAskId'], askedByPersonId: w.ben.personId },
    ]);
  });

  it('answers a replay of the same operation as the first, storing one ask', async () => {
    const asked = await live(w);
    const body = { operationId: randomUUID(), ...revertBody(asked.correctionId) };
    const send = async () =>
      await executeCommand(w.world.db.app, w.world.business, w.ben.presented, 'api', body as never);
    const first = await send();
    const again = await send();
    expect(codeOf(first)).toBe('not-a-refusal');
    expect(codeOf(again)).toBe('not-a-refusal');
    expect(detailOf(again)['revertAskId']).toBe(detailOf(first)['revertAskId']);
    expect((await asksOn(w, asked.correctionId)).length).toBe(1);
  });
});

describe.skipIf(serverUrl === undefined)('a revert ask on a correction that is not live', () => {
  it('refuses a correction that is requested, approved or already reverted', async () => {
    await refusedWith(w.ben, await requested(w), 'TRANSITION_NOT_PERMITTED', 'requested');
    await refusedWith(w.ben, await approved(w), 'TRANSITION_NOT_PERMITTED', 'approved');
    const reverted = await live(w);
    await moveTo(w, reverted.correctionId, 'reverted');
    await refusedWith(w.ben, reverted, 'TRANSITION_NOT_PERMITTED', 'reverted');
  });
});

describe.skipIf(serverUrl === undefined)('a stored revert ask', () => {
  it('is kept as written: the application can neither change nor remove it', async () => {
    const asked = await live(w);
    expect(codeOf(await askAs(w.ben, asked))).toBe('not-a-refusal');
    const tamper = async (sql: string) =>
      await w.world.db.app.withBusiness(w.world.business, async (tx) => {
        await tx.query(sql, [asked.correctionId]);
      });
    await expect(
      tamper(
        `update public.live_correction_revert_asks set asked_by_person_id = asked_by_person_id
          where correction_id = $1`,
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      tamper('delete from public.live_correction_revert_asks where correction_id = $1'),
    ).rejects.toThrow(/permission denied/u);
    expect((await asksOn(w, asked.correctionId)).length).toBe(1);
  });
});

describe.skipIf(serverUrl === undefined)('who may ask to revert', () => {
  it('refuses any other staff account holding the gate grant', async () => {
    await refusedWith(w.cal, await live(w), 'APPROVER_NOT_CONFIGURED_ONE');
  });

  it('refuses the requester, even as the configured approver', async () => {
    const asked = await live(w);
    expect(codeOf(await w.setApprover(w.ava.personId))).toBe('not-a-refusal');
    await refusedWith(w.ava, asked, 'SELF_APPROVAL_REFUSED');
  });

  it('refuses every ask while no approver is configured', async () => {
    const asked = await live(w);
    expect(codeOf(await w.setApprover(null))).toBe('not-a-refusal');
    await refusedWith(w.ben, asked, 'APPROVER_NOT_CONFIGURED');
  });

  it('refuses every ask once the configured approver is no longer an active member', async () => {
    const asked = await live(w);
    const fay = await w.world.decider(`fay${randomUUID().slice(0, 6)}`);
    expect(codeOf(await w.setApprover(fay.personId))).toBe('not-a-refusal');
    await w.world.db.admin.execute(
      `update public.memberships set active = false, ended_at = now()
        where business_id = $1 and person_id = $2`,
      [w.world.business, fay.personId],
    );
    await refusedWith(w.ben, asked, 'APPROVER_NOT_CONFIGURED');
  });
});

describe.skipIf(serverUrl === undefined)("a revert ask outside the asker's gate grant", () => {
  it("refuses an approver whose gate grant does not reach the correction's client", async () => {
    const asked = await live(w);
    expect(codeOf(await w.setApprover(w.dee.personId))).toBe('not-a-refusal');
    await refusedWith(w.dee, asked, 'SCOPE_NOT_GRANTED');
  });

  it('refuses an approver holding the run grant but not the gate grant', async () => {
    const asked = await live(w);
    const gil = await w.world.decider(`gil${randomUUID().slice(0, 6)}`);
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, gil, 'write', { kind: 'business', id: null }, false, 'run');
    });
    expect(codeOf(await w.setApprover(gil.personId))).toBe('not-a-refusal');
    await refusedWith(gil, asked, 'SCOPE_NOT_GRANTED');
  });

  it('refuses a correction of another business, or an id naming none, as if absent', async () => {
    const asked = await live(w);
    const elsewhere = await w.asIn(w.beta, w.eve, revertBody(asked.correctionId));
    expect(codeOf(elsewhere)).toBe('NOT_FOUND');
    expect(codeOf(await w.as(w.ben, revertBody(randomUUID())))).toBe('NOT_FOUND');
    expect(await asksOn(w, asked.correctionId)).toEqual([]);
  });
});
