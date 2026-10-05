// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { signalOf } from '../../apps/api/alerts/detect.ts';
import { createAlerts, type SinkEvent } from '../../apps/api/alerts/sink.ts';
import { composeApi } from '../../apps/api/server.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { authorised, createApiFixture, ISSUER, post, tokenFor } from '../api/fixture.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'successful access grants and revocations raise authority-change signals',
  // eslint-disable-next-line max-lines-per-function -- one grant then its revocation, read as one case
  async () => {
    const outcome = {
      business: 'alpha',
      person: 'supabase\u0000owner',
      refusal: undefined,
      items: 0,
    };
    const expected = { kind: 'authority-changed', business: outcome.business };
    // The old revoke remains a positive control.
    expect(signalOf({ ...outcome, command: 'grant.revoke' })).toEqual(expected);
    const fixture = await createApiFixture('sol_ow004_detect');
    try {
      await fixture.db.app.withBusiness(fixture.business, async (tx) => {
        await grantTo(tx, fixture.member, 'manage', undefined, false, 'access');
      });
      const recipient = await enrol(fixture.db.app, fixture.business, 'Sol recipient');
      const sent: SinkEvent[] = [];
      const alerts = createAlerts({
        where: 'staging',
        root: process.cwd(),
        send: (event) => {
          sent.push(event);
          return Promise.resolve();
        },
      });
      const api = composeApi({
        database: fixture.db.app,
        admin: fixture.db.admin,
        keys: runtimeKeys({ ...fixture.environment }),
        signIn: testSignIn(ISSUER),
        alerts,
      }).app;
      const headers = authorised(
        await tokenFor(fixture.member.presented.subject, { secondFactor: true }),
      );
      const given = await post(
        api,
        `${PREFIX.person}alpha/access/grant`,
        {
          operationId: randomUUID(),
          holderId: recipient.personId,
          collection: 'task',
          action: 'read',
        },
        headers,
      );
      expect(given.status).toBe(200);
      const grantId = String((given.body['detail'] as { grantId: string }).grantId);
      await alerts.settled();
      const afterGrant = sent.map((event) => event.tags['alert']);
      const revoked = await post(
        api,
        `${PREFIX.person}alpha/access/revoke`,
        {
          operationId: randomUUID(),
          grantId,
        },
        headers,
      );
      expect(revoked.status).toBe(200);
      await alerts.settled();
      const rows = await fixture.db.admin.execute<{ revoked: boolean }>(
        'select revoked_at is not null as revoked from public.grants where business_id = $1 and id = $2',
        [fixture.business, grantId],
      );
      expect(rows).toEqual([{ revoked: true }]);
      expect({ afterGrant, afterRevoke: sent.map((event) => event.tags['alert']) }).toEqual({
        afterGrant: ['authority-changed'],
        afterRevoke: ['authority-changed', 'authority-changed'],
      });
    } finally {
      await fixture.drop();
    }
  },
);

it('ending access, like a grant or a revocation, is an authority change', () => {
  const outcome = { business: 'alpha', person: '', refusal: undefined, items: 0 };
  for (const command of ['access.grant', 'access.revoke', 'access.end']) {
    expect(signalOf({ ...outcome, command })).toEqual({
      kind: 'authority-changed',
      business: 'alpha',
    });
  }
  expect(signalOf({ ...outcome, command: 'access.read' })).toBeUndefined();
  expect(signalOf({ ...outcome, command: 'access.end', refusal: 'SCOPE_NOT_GRANTED' })).toEqual({
    kind: 'cross-scope-refusal',
    business: 'alpha',
    person: '',
  });
});
