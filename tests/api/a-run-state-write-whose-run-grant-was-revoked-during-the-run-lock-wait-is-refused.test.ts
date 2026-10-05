// SPDX-License-Identifier: AGPL-3.0-only
//
// `run.revise_state` asks the caller's `run:write`, waits for the run row
// (`reviseRunState`), and asks it again once it holds it. A fixture transaction holds
// the run row; the write is admitted through the real API on the live grant
// and parks on the row; the grant is revoked and commits; then the fixture
// lets go. The write must be refused `SCOPE_NOT_GRANTED` and append no state
// version.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import { PROPOSAL } from '../acceptance/role-case-bodies.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let fixture: ApiFixture;
let api: Hono;
let token: string;
let runGrant: string;

const call = async (via: Hono, command: CommandName, body: Record<string, unknown>) =>
  await post(
    via,
    `/api/b/${BUSINESS_KEY}${pathOf(command)}`,
    { operationId: randomUUID(), ...body },
    authorised(token),
  );

beforeAll(async () => {
  if (noDatabase) return;
  fixture = await createApiFixture('runstaterevoked');
  api = fixture.compose();
  token = await tokenFor(fixture.member.presented.subject, { secondFactor: true });
  runGrant = await fixture.db.app.withBusiness(
    fixture.business,
    async (tx) => await grantTo(tx, fixture.member, 'write', undefined, false, 'run'),
  );
}, 180_000);
afterAll(async () => await fixture?.drop());

/** A task with a proposed run on it. */
async function proposedRun(): Promise<{ readonly recordId: unknown; readonly runId: unknown }> {
  const made = await call(api, 'task.create', { fields: { title: 'Run state revocation race' } });
  if (made.status !== 200) throw new Error(`task.create answered ${made.status}`);
  const recordId = made.body['recordId'];
  const proposed = await call(api, 'task.propose', {
    recordId,
    expectedRevision: made.body['revision'],
    ...PROPOSAL,
  });
  const detail = proposed.body['detail'];
  if (typeof detail !== 'object' || detail === null || !('runId' in detail))
    throw new Error(`task.propose answered ${proposed.status} with no run`);
  return { recordId, runId: detail.runId };
}

it('a run-state write whose run grant was revoked during the run lock wait is refused, and appends nothing', async () => {
  const { recordId, runId } = await proposedRun();
  const writer = connect(fixture.db.appUrl);
  const revoker = connect(fixture.db.appUrl);
  try {
    const run = await hold(fixture.db.appUrl, fixture.business, async (tx) => {
      await tx.query(
        'select id from public.planned_runs where business_id = $1 and id = $2 for update',
        [tx.businessId, runId],
      );
    });
    let writing: ReturnType<typeof call> | undefined;
    try {
      writing = call(fixture.compose(undefined, undefined, writer), 'run.revise_state', {
        recordId,
        runId,
        expectedVersion: 0,
        knowledge: ['race text'],
        unknowns: [],
      });
      await waitingOn(fixture.db.admin, 'transactionid', 'select id from public.planned_runs');
      await revoker.withBusiness(fixture.business, async (tx) => {
        expect(await revokeGrant(tx, runGrant)).not.toBeNull();
      });
    } finally {
      await run.letGo();
    }
    const answer = await writing;
    const versions = await fixture.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.run_states where business_id = $1 and run_id = $2',
      [fixture.business, runId],
    );
    const refusal = answer.body['refused'] === true ? answer.body['code'] : undefined;
    expect({ answer: refusal ?? answer.status, versions: versions[0]?.n }).toEqual({
      answer: 'SCOPE_NOT_GRANTED',
      versions: 0,
    });
  } finally {
    await Promise.all([writer.close(), revoker.close()]);
  }
});
