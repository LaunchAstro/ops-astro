// SPDX-License-Identifier: AGPL-3.0-only
//
// R5 (#1689): single-operator Launch. Business beta has one operator (eve),
// who is its configured approver. With single-operator mode on, she approves a
// correction she requested herself, marked as a single-operator self-approval
// on its decision; the business's first such approval also needs Astra's
// review recorded for the correction's exact version. With the mode off,
// self-approval is refused by the command and by the table. Alpha, with several
// operators, keeps the second-person control. The second operator and the lock
// waits are `single-operator-second-operator.test.ts`.

import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { agentOwnedBy } from '../commands/fixture.ts';
import { ABOUT, PAGE, type C80World } from './c80-world.ts';
import { insertLiveCorrection } from '../../packages/core-records/src/index.ts';
import {
  asEve,
  decide,
  eveRequests,
  modeIn,
  recordReview,
  REVIEW,
  rowOf,
  setMode,
  soloWorld,
  type Asked,
} from './single-operator-world.ts';
import { randomUUID } from 'node:crypto';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('Single-operator Launch: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
/** Eve's first correction, requested once the mode is on. */
let first: Asked;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await soloWorld('solo');
});

describe.skipIf(serverUrl === undefined)('with single-operator mode off', () => {
  it('refuses self-approval SELF by the command, writing nothing', async () => {
    const own = await eveRequests(w);
    expect(await modeIn(w, w.beta)).toBe(false);
    expect(codeOf(await decide(w, own))).toBe('SELF_APPROVAL_REFUSED');
    expect(await rowOf(w, own.id)).toMatchObject({
      state: 'requested',
      decided_by_person_id: null,
    });
  });

  it('refuses a direct self-decision without the mark by the table', async () => {
    const own = await eveRequests(w);
    await expect(
      w.world.db.admin.execute(
        `update public.live_corrections
            set state = 'approved', decided_by_actor_id = requested_by_actor_id,
                decided_by_person_id = requested_by_person_id, decided_at = now(),
                decided_version_digest = version_digest
          where id = $1`,
        [own.id],
      ),
    ).rejects.toThrow(/live_corrections_no_self_approval/u);
  });
});

describe.skipIf(serverUrl === undefined)('the table, with the mode off', () => {
  it('refuses a row inserted already carrying the mark', async () => {
    const own = await eveRequests(w);
    await expect(
      w.world.db.admin.execute(
        `insert into public.live_corrections
           select (jsonb_populate_record(c, jsonb_build_object(
                    'id', gen_random_uuid(), 'version_id', gen_random_uuid(),
                    'state', 'approved', 'decided_by_actor_id', c.requested_by_actor_id,
                    'decided_by_person_id', c.requested_by_person_id, 'decided_at', now(),
                    'decided_version_digest', c.version_digest,
                    'single_operator_self_approval', true))).*
             from public.live_corrections c where c.id = $1`,
        [own.id],
      ),
    ).rejects.toThrow(/live_corrections_self_approval_kept: a request is stored unmarked/u);
  });

  it('refuses a direct write of the mark while the mode is off', async () => {
    const own = await eveRequests(w);
    await expect(
      w.world.db.admin.execute(
        `update public.live_corrections
            set state = 'approved', decided_by_actor_id = requested_by_actor_id,
                decided_by_person_id = requested_by_person_id, decided_at = now(),
                decided_version_digest = version_digest, single_operator_self_approval = true
          where id = $1`,
        [own.id],
      ),
    ).rejects.toThrow(/live_corrections_self_approval_kept: single_operator_mode is off/u);
  });
});

describe.skipIf(serverUrl === undefined)('the second-person control with the mode off', () => {
  it('lets the other configured approver decide as today, unmarked', async () => {
    const asked = await w.request(w.ava);
    const detail = detailOf(asked);
    const approved = await w.approve(
      w.ben,
      String(detail['correctionId']),
      String(detail['versionId']),
    );
    expect(codeOf(approved)).toBe('not-a-refusal');
    expect(await rowOf(w, String(detail['correctionId']))).toMatchObject({
      state: 'approved',
      single_operator_self_approval: false,
    });
  });

  it('refuses turning the mode on while a second operator exists', async () => {
    expect(codeOf(await setMode(w, w.world.business, w.admin, true))).toBe(
      'SINGLE_OPERATOR_REFUSED',
    );
    expect(await modeIn(w, w.world.business)).toBe(false);
  });
});

describe.skipIf(serverUrl === undefined)('with single-operator mode on', () => {
  beforeAll(async () => {
    if (serverUrl === undefined) return;
    // Each test asserts what it needs; the setup asserts nothing, so none is skipped.
    await setMode(w, w.beta, w.eve, true);
    first = await eveRequests(w);
  });

  it('shows the mode in the business settings', async () => {
    expect(await modeIn(w, w.beta)).toBe(true);
  });

  it('refuses the first Launch with no Astra review, and it stays requested', async () => {
    expect(codeOf(await decide(w, first))).toBe('ASTRA_REVIEW_MISSING');
    expect(await rowOf(w, first.id)).toMatchObject({ state: 'requested' });
  });

  it('refuses the first Launch on a review bound to another version', async () => {
    await w.world.db.admin
      .execute(
        `insert into public.live_correction_reviews
         (business_id, id, correction_id, version_digest, verdict, review,
          recorded_by_actor_id, recorded_by_person_id)
       select business_id, gen_random_uuid(), id, 'sha256:an-earlier-version', 'approve', $2,
              requested_by_actor_id, requested_by_person_id
         from public.live_corrections where id = $1`,
        [first.id, REVIEW],
      )
      .catch(String);
    expect(codeOf(await decide(w, first))).toBe('ASTRA_REVIEW_MISSING');
    expect(await rowOf(w, first.id)).toMatchObject({ state: 'requested' });
  });
});

describe.skipIf(serverUrl === undefined)('Astra’s review of the first Launch', () => {
  it('refuses recording a review that names another version digest', async () => {
    expect(codeOf(await recordReview(w, first.id, 'sha256:not-this-version'))).toBe(
      'VERSION_STALE',
    );
  });

  it('refuses the first Launch on a review that does not approve', async () => {
    expect(codeOf(await recordReview(w, first.id, first.digest, 'changes_requested'))).toBe(
      'not-a-refusal',
    );
    expect(codeOf(await decide(w, first))).toBe('ASTRA_REVIEW_MISSING');
  });
});

describe.skipIf(serverUrl === undefined)('the first Launch and after', () => {
  it('approves her own correction once Astra’s review of this version is recorded, marked', async () => {
    expect(codeOf(await recordReview(w, first.id, first.digest))).toBe('not-a-refusal');
    expect(codeOf(await decide(w, first))).toBe('not-a-refusal');
    expect(await rowOf(w, first.id)).toMatchObject({
      state: 'approved',
      decided_by_person_id: w.eve.personId,
      single_operator_self_approval: true,
    });
  });
});

describe.skipIf(serverUrl === undefined)('after the first Launch', () => {
  it('approves her own agent’s correction after the first, marked, with no review needed', async () => {
    // The agent asks for eve, so eve is recorded as the requester (release decision 3.4).
    const agent = await agentOwnedBy(w.world.db.app, w.beta, w.eve.personId);
    const stored = await w.world.db.app.withBusiness(
      w.beta,
      async (tx) =>
        await insertLiveCorrection(tx, {
          partyId: w.betaParty,
          taskId: w.betaTask,
          requestedByActorId: agent,
          requestedByPersonId: w.eve.personId,
          delegationId: null,
          targetPath: ABOUT,
          word: 'friendly',
          replacement: 'welcoming',
          pageUrl: PAGE,
          preImageDigest: 'sha256:pre-image',
          baseRevision: 'rev-1',
          seam: `seam-${randomUUID()}`,
          versionDigest: 'sha256:the-agents-version',
        }),
    );
    if ('code' in stored) throw new Error(`the agent's request was refused ${stored.code}`);
    expect(codeOf(await decide(w, { id: stored.id, versionId: stored.versionId }))).toBe(
      'not-a-refusal',
    );
    expect(await rowOf(w, stored.id)).toMatchObject({
      decided_by_person_id: w.eve.personId,
      single_operator_self_approval: true,
    });
  });

  it('lets her ask to revert her own live correction under the mark', async () => {
    await w.world.db.admin
      .execute(`update public.live_corrections set state = 'live' where id = $1`, [first.id])
      .catch(String);
    const asked = await asEve(w, { command: 'live_correction.revert', correctionId: first.id });
    expect(codeOf(asked)).toBe('not-a-refusal');
  });
});
