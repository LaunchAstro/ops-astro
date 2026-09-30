// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-6-1 refusal preference:write, MP-6-1 own preference only and MP-6-1 no
// audit for unaudited: the job list's show or hide (CS-6.2) is the person's
// own preference, saved through the one preference store (MP-2-11a).
//
// That store is built ahead on another slice and is not in this tree yet, so
// these cases run once `preference.save` is on the surface, after the rebase
// that brings the store in. The key `agent.jobList` (a boolean) is added to the
// store's closed key list then. Until the store is here the Agent pane keeps
// the choice for the life of the page (`apps/web/src/views/agent-pane.tsx`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();
const storeIsHere = COMMAND_SURFACE.some((row) => String(row.name) === 'preference.save');

// eslint-disable-next-line max-lines-per-function -- one person's preference, the refusals around it
describe.skipIf(serverUrl === undefined || !storeIsHere)('MP-6-1 job list preference', () => {
  let c: Controls;
  let other: Member;

  beforeAll(async () => {
    c = await createControls('mp_6_1_preferences');
    other = await enrol(c.fixture.db.app, c.fixture.business, 'other');
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, other, 'read');
    });
  }, 120_000);

  afterAll(async () => await c?.drop());

  const save = (body: Record<string, unknown>, as?: Member) =>
    c.asPerson('preference.save' as never, { operationId: randomUUID(), ...body }, as);
  const rows = (personId: string) =>
    c.count(
      `select count(*)::text as n from public.person_preferences
        where person_id = $1 and key = 'agent.jobList'`,
      [personId],
    );

  it('MP-6-1 own preference only', async () => {
    const saved = await save({ preference: 'agent.jobList', value: true });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await rows(c.manager.personId)).toBe(1);
    expect(await rows(other.personId)).toBe(0);

    const aimed = await save({
      preference: 'agent.jobList',
      value: false,
      personId: other.personId,
    });
    expect(aimed.status).toBeGreaterThanOrEqual(400);
    expect(await rows(other.personId)).toBe(0);
  });

  it('MP-6-1 refusal preference:write', async () => {
    const agent = await c.asAgent('preference.save' as never, {
      operationId: randomUUID(),
      preference: 'agent.jobList',
      value: true,
    });
    expect(agent.status).toBeGreaterThanOrEqual(400);
    expect(await rows(c.fixture.agentActorId)).toBe(0);
  });

  it('MP-6-1 no audit for unaudited', async () => {
    const operationId = randomUUID();
    const saved = await c.asPerson('preference.save' as never, {
      operationId,
      preference: 'agent.jobList',
      value: false,
    });
    expect(saved.status).toBe(200);
    expect(
      await c.count(`select count(*)::text as n from public.audit_events where operation_id = $1`, [
        operationId,
      ]),
    ).toBe(0);
  });
});
