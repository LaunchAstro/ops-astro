// SPDX-License-Identifier: AGPL-3.0-only
//
// Revocation through its owning operations: `grant.revoke` and
// `delegation.revoke`, reached at their own paths on the person prefix.
//
// Contract ledger: "Existing grant/delegation revocation controls — current
// existing grant-manager authority, within its own delegation ceiling —
// timestamped revocation and audit; next operation re-evaluates". I10's
// endpoint half is the first case: a read admitted before the revocation
// finished with its content, and the next read on the same session is denied
// with none. Nothing below revokes by SQL; the only revocation is the route.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { createControls, detailOf, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('grant.revoke and delegation.revoke over HTTP', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('ctlrv');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  it('I10: a read admitted before the revocation finished; the next one on the session is denied', async () => {
    const task = await c.createTask('a task the reader can see until revoked');
    const before = await c.asPerson('task.read', { recordId: task.id }, c.reader);
    expect(before.status).toBe(200);
    expect(JSON.stringify(before.body)).toContain(task.id);

    const revoked = await c.asPerson('grant.revoke', { grantId: c.readerGrantId });
    expect(revoked.status).toBe(200);
    expect(revoked.body['command']).toBe('grant.revoke');
    const detail = detailOf(revoked);
    expect(detail['grantId']).toBe(c.readerGrantId);
    expect(Number.isNaN(Date.parse(String(detail['revokedAt'])))).toBe(false);

    // The timestamp is on the row, and the audit chain carries the applied
    // revocation against the grant it revoked.
    expect(
      await c.count(
        `select count(*)::text as n from public.grants where id = $1 and revoked_at is not null`,
        [c.readerGrantId],
      ),
    ).toBe(1);
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'grant.revoke' and outcome = 'applied' and subject_record_id = $1`,
        [c.readerGrantId],
      ),
    ).toBe(1);

    const after = await c.asPerson('task.read', { recordId: task.id }, c.reader);
    expect(after.status).toBe(403);
    expect(after.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(after.body)).not.toContain(task.id);
  });

  it('refuses a caller with no grant-manager authority, and leaves the grant live', async () => {
    const other = await enrol(c.fixture.db.app, c.fixture.business, 'bystander');
    let grantId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      grantId = await grantTo(tx, other, 'read');
    });
    const refused = await c.asPerson('grant.revoke', { grantId }, other);
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(
      await c.count(
        `select count(*)::text as n from public.grants where id = $1 and revoked_at is null`,
        [grantId],
      ),
    ).toBe(1);
  });

  it('refuses a manager revoking past its own ceiling: a pair it does not hold', async () => {
    // The manager holds task read/write/decide/assign/comment/manage and no
    // `share`. A `share` grant on tasks is outside what it could itself hold.
    const other = await enrol(c.fixture.db.app, c.fixture.business, 'sharer');
    let grantId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      grantId = await grantTo(tx, other, 'share');
    });
    const refused = await c.asPerson('grant.revoke', { grantId });
    expect(refused.status).toBe(403);
    expect(refused.body['code']).toBe('SCOPE_NOT_GRANTED');
  });

  it('answers a grant that is not there, and a second revocation, without writing', async () => {
    const missing = await c.asPerson('grant.revoke', { grantId: randomUUID() });
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('NOT_FOUND');

    const twice = await c.asPerson('grant.revoke', { grantId: c.readerGrantId });
    expect(twice.status).toBe(409);
    expect(twice.body['code']).toBe('TRANSITION_NOT_PERMITTED');
  });

  it('revokes an agent’s delegation, and the agent’s next call is refused', async () => {
    const task = await c.createTask('a task an agent picks up and loses');
    const reservationId = await c.approve(await c.propose(task.id, task.revision, 'revoke_me'));
    const picked = await c.pickup(reservationId);
    const credential = String(picked['credential']);

    const reading = await c.asAgent('task.read', { recordId: task.id }, credential);
    expect(reading.status).toBe(200);

    const revoked = await c.asPerson('delegation.revoke', { delegationId: picked['delegationId'] });
    expect(revoked.status).toBe(200);
    expect(detailOf(revoked)['delegationId']).toBe(picked['delegationId']);
    expect(
      await c.count(
        `select count(*)::text as n from public.audit_events
          where command = 'delegation.revoke' and outcome = 'applied' and subject_record_id = $1`,
        [picked['delegationId']],
      ),
    ).toBe(1);

    const next = await c.asAgent('task.read', { recordId: task.id }, credential);
    expect(next.status).toBe(401);
    expect(next.body['code']).toBe('DELEGATION_NOT_LIVE');
    expect(JSON.stringify(next.body)).not.toContain('draft a reply');

    const twice = await c.asPerson('delegation.revoke', { delegationId: picked['delegationId'] });
    expect(twice.body['code']).toBe('DELEGATION_NOT_LIVE');

    const outsider = await c.asPerson(
      'delegation.revoke',
      { delegationId: picked['delegationId'] },
      c.reader,
    );
    expect(outsider.status).toBe(403);
    expect(outsider.body['code']).toBe('SCOPE_NOT_GRANTED');
  });

  it('is not an agent operation: the agent prefix refuses both', async () => {
    for (const name of ['grant.revoke', 'delegation.revoke']) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await c.asAgent(name, { grantId: c.readerGrantId });
      expect(answer.status, name).toBe(403);
      expect(answer.body['code'], name).toBe('DELEGATION_EXCLUDES_OPERATION');
    }
  });
});
