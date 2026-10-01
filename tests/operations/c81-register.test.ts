// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the overseas-services register (SP-25) and the privacy policy that
// reads it. Each row of the register is set by `privacy.set_overseas_service`
// under `privacy:manage`, never an agent's, and every change is a tracked,
// audited operation. A privacy-policy version is drafted with the register as
// it stood (the rows in use and their digest, fixed on the version); approving
// or publishing it is refused while any of those rows is marked "to confirm",
// or once the register has changed since the draft. The public read of the
// policy carries the services beside the words.
//
// Ada is alpha's owner and holds `privacy:manage`; Noah holds `operations:read`
// alone; Mia holds neither; Bea is bravo's owner and holds `privacy:manage`
// there. A client of alpha holds a share and nothing else, and the agent acts
// under a live delegation from Ada. Every service below is made up.
//
// The world is `c81-register-world.ts`; the race, the refusals, the three
// crossings and the canary are in `c81-register-isolation.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import {
  approve,
  CANARY,
  closeRegister,
  detailOf,
  draft,
  harness,
  listed,
  openRegister,
  publish,
  readPolicy,
  registerRows,
  releasePolicy,
  row,
  set,
  setOk,
} from './c81-register-world.ts';

if (serverUrl === undefined) {
  console.warn('operations/c81-register: DATABASE_URL is unset, so nothing below ran.');
}

beforeAll(async () => {
  if (serverUrl !== undefined) await openRegister('c81_register');
}, 120_000);

afterAll(async () => {
  if (serverUrl !== undefined) await closeRegister();
});

async function c81RegisterCompleteInThePolicyA(): Promise<void> {
  const first = row();
  await setOk(first);
  const one = await releasePolicy();
  expect(one.json['services']).toEqual([listed(first)]);

  // A row added: the published policy is unchanged in place, and the next
  // version lists both, in the register's order.
  const added = row({ service: `${first.service} two`, where: 'Australia: Sydney' });
  await setOk(added);
  expect((await readPolicy()).json).toEqual(one.json);
  const two = await releasePolicy();
  expect(two.json['services']).toEqual([listed(first), listed(added)]);

  // A row marked "to confirm": a draft may be made to read, but it is not
  // ready, and the published version stays the one before.
  await setOk({ ...added, operationId: randomUUID(), toConfirm: true });
  const unconfirmed = await draft();
  const notReady = await approve(unconfirmed);
  expect({ status: notReady.status, code: notReady.code }).toEqual({
    status: 409,
    code: 'LEGAL_REGISTER_UNCONFIRMED',
  });
  expect((await readPolicy()).json).toEqual(two.json);
  // The other documents do not read the register.
  const terms = await draft('client-terms');
  expect((await approve(terms)).status).toBe(200);

  // Confirmed again: the draft made before is spent (the register changed
  // since), and a new draft is ready.
  await setOk({ ...added, operationId: randomUUID(), toConfirm: false });
  const stale = await approve(unconfirmed);
  expect({ status: stale.status, code: stale.code }).toEqual({
    status: 409,
    code: 'LEGAL_REGISTER_CHANGED',
  });

  // Approved, then the register changes before publication: not published.
  const approved = await draft();
  expect((await approve(approved)).status).toBe(200);
  const changed = row({ where: 'the United States' });
  await setOk(changed);
  const late = await publish(approved.versionId);
  expect({ status: late.status, code: late.code }).toEqual({
    status: 409,
    code: 'LEGAL_REGISTER_CHANGED',
  });
  expect((await readPolicy()).json).toEqual(two.json);

  // A service no longer in use leaves the next policy.
  await setOk({ ...changed, operationId: randomUUID(), inUse: false });
  const three = await releasePolicy();
  expect(three.json['services']).toEqual([listed(first), listed(added)]);

  // The register a version was drafted from is written once with it.
  for (const edit of [
    `update public.legal_document_versions set register = '[]'::jsonb where document = 'privacy-policy'`,
    `update public.legal_document_versions set register_digest = md5('x') where document = 'privacy-policy'`,
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const refusal = await harness.world.db.app
      .withBusiness(harness.world.alpha, async (tx) => await tx.query(edit))
      .then(
        () => 'applied',
        (error: unknown) => String((error as { readonly code?: unknown }).code),
      );
    expect(refusal, edit).toBe('23001');
  }
  expect((await readPolicy()).json).toEqual(three.json);
}

async function c81RegisterSetEveryChangeIsTracked(): Promise<void> {
  const sent = row();
  const setOnce = await setOk(sent);
  const serviceId = detailOf(setOnce)['serviceId'];
  const again = await set({ ...sent, operationId: randomUUID(), receives: 'recipient address' });
  expect(detailOf(again)['serviceId']).toBe(serviceId);
  // The same service in other letter case is the same row.
  const cased = await set({
    ...sent,
    operationId: randomUUID(),
    service: sent.service.toUpperCase(),
  });
  expect(detailOf(cased)['serviceId']).toBe(serviceId);
  const audited = await harness.world.db.app.withBusiness(
    harness.world.alpha,
    async (tx) =>
      await tx.query<{ readonly n: number }>(
        `select count(*)::int as n from public.audit_events
        where command = 'privacy.set_overseas_service' and outcome = 'applied'
          and subject_record_id = $1`,
        [serviceId],
      ),
  );
  expect(audited[0]?.n).toBe(3);

  const before = await registerRows(harness.world.alpha);
  const cases: readonly (readonly [Readonly<Record<string, unknown>>, string])[] = [
    [row({ service: '' }), 'service'],
    [row({ service: 'x'.repeat(121) }), 'service'],
    [row({ service: 7 }), 'service'],
    [row({ receives: '   ' }), 'receives'],
    [row({ receives: 'x'.repeat(2001) }), 'receives'],
    [row({ where: undefined }), 'where'],
    [row({ trainsOnIt: '' }), 'trainsOnIt'],
    [row({ contract: [] }), 'contract'],
    [row({ toConfirm: 'yes' }), 'toConfirm'],
    [row({ inUse: undefined }), 'inUse'],
  ];
  for (const [body, field] of cases) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await set(body);
    expect({ status: answer.status, code: answer.code }, field).toEqual({
      status: 422,
      code: 'FIELD_VALUE_INVALID',
    });
    expect(JSON.stringify(answer.body), field).toContain(field);
  }
  for (const field of ['service', 'receives', 'where', 'trainsOnIt', 'contract']) {
    for (const bad of [`nul \u0000 ${CANARY}`, `lone \uD800 ${CANARY}`]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await set(row({ [field]: bad }));
      expect({ status: answer.status, code: answer.code }, field).toEqual({
        status: 422,
        code: 'FIELD_VALUE_INVALID',
      });
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
  }
  const undeclared = await set({ ...row(), region: 'Sydney' });
  expect({ status: undeclared.status, code: undeclared.code }).toEqual({
    status: 400,
    code: 'COMMAND_BODY_INVALID',
  });
  expect(await registerRows(harness.world.alpha)).toEqual(before);
}

describe.skipIf(serverUrl === undefined)('C81 the overseas-services register', () => {
  it(
    'C81 register complete in the policy: a row added is in the next policy, and a row to confirm or a change since the draft leaves the policy not ready',
    c81RegisterCompleteInThePolicyA,
  );

  it('C81 policy names what each service receives: no personal information to the model providers, the master Drive by public link, review media possibly overseas', async () => {
    const rows = [
      row({
        service: 'Model provider: Claude',
        receives: 'no personal information',
        where: 'overseas (United States)',
      }),
      row({
        service: 'Model provider: ChatGPT',
        receives: 'no personal information',
        where: 'overseas (United States)',
      }),
      row({
        service: 'Master Drive',
        receives:
          'client production files; each client folder is shared by public link, so anyone holding the link can open it',
        where: 'may be stored outside Australia',
      }),
      row({
        service: 'Cloudflare R2 (review media)',
        receives: 'review videos and other review media',
        where:
          'the Oceania region requested, not guaranteed to stay in Australia, so possibly overseas',
      }),
    ];
    for (const sent of rows) {
      // oxlint-disable-next-line no-await-in-loop
      await setOk(sent);
    }
    const policy = await releasePolicy();
    const services = policy.json['services'] as readonly Record<string, unknown>[];
    for (const sent of rows) {
      expect(services, sent.service).toContainEqual(listed(sent));
    }
    // Each is listed once, with its own words and nothing of another row's.
    expect(new Set(services.map((service) => service['service'])).size).toBe(services.length);
  });

  it(
    'C81 register set: every change is tracked and audited, one row per service, and malformed input is refused by name with nothing written',
    c81RegisterSetEveryChangeIsTracked,
  );
});
