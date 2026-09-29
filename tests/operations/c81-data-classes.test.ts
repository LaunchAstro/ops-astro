// SPDX-License-Identifier: AGPL-3.0-only
//
// C81: the data-class register. Each class of personal information is set by
// `privacy.set_data_class` under `privacy:manage`, never an agent's, with its
// purpose, normal disclosures, retention and deletion, each required; every
// change is a tracked, audited operation. A privacy-policy version is drafted
// with the classes in use and their digest, fixed on the version; approving or
// publishing it is refused once the classes have changed since the draft. The
// public read of the policy carries the classes beside the words, and the
// records package reads the same register for C62's retention table and the
// privacy-request workflows (C61-R). The refusals, the lock and the three
// crossings are `c81-data-classes-isolation.test.ts`; the world is
// `c81-data-classes-world.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readDataClasses } from '../../packages/core-records/src/operations/data-classes.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  approve,
  classRows,
  closeWorld,
  dataClass,
  draft,
  FIELDS,
  h,
  listed,
  openWorld,
  publish,
  readPolicy,
  releasePolicy,
  set,
  setOk,
} from './c81-data-classes-world.ts';

const CANARY = 'CANARY-c81-data-class-set-2e7a91';

if (serverUrl === undefined) {
  console.warn('operations/c81-data-classes: DATABASE_URL is unset, so nothing below ran.');
}

const test = it.skipIf(serverUrl === undefined);

beforeAll(async () => {
  if (serverUrl !== undefined) await openWorld('c81_data_classes');
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const code = (error: unknown) => String((error as { readonly code?: unknown }).code);

test('C81 data classes covered: a class missing its purpose, disclosures, retention or deletion is refused by name, and by the table in SQL', async () => {
  const before = await classRows(h().world.alpha);
  for (const field of FIELDS) {
    for (const bad of ['', '   ', undefined, 7]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await set(dataClass({ [field]: bad }));
      expect({ status: answer.status, code: answer.code }, field).toEqual({
        status: 422,
        code: 'FIELD_VALUE_INVALID',
      });
      expect(JSON.stringify(answer.body), field).toContain(field);
    }
  }
  expect(await classRows(h().world.alpha)).toEqual(before);
  const refusedInSql = await h()
    .world.db.app.withBusiness(
      h().world.alpha,
      async (tx) =>
        await tx.query(
          `insert into public.data_classes
             (business_id, id, data_class, purpose, disclosures, retention, deletion, in_use,
              updated_by_actor)
           values ($1, gen_random_uuid(), 'x', 'x', 'x', ' ', 'x', true, $2)`,
          [h().world.alpha, h().world.ada.actorId],
        ),
    )
    .then(() => 'applied', code);
  expect(refusedInSql, 'a class with no retention, in SQL').toBe('23514');
});

test('C81 data classes covered: the policy reads the classes as they were drafted, and a change since spends the draft or the approval', async () => {
  const first = dataClass();
  await setOk(first);
  const one = await releasePolicy();
  expect(one.json['dataClasses']).toEqual([listed(first)]);
  const second = dataClass({ dataClass: `${first.dataClass} two` });
  await setOk(second);
  expect((await readPolicy()).json).toEqual(one.json);

  const stale = await draft();
  await setOk({ ...second, operationId: randomUUID(), retention: 'two years' });
  const late = await approve(stale);
  expect({ status: late.status, code: late.code }).toEqual({
    status: 409,
    code: 'LEGAL_DATA_CLASSES_CHANGED',
  });
  const approved = await draft();
  expect((await approve(approved)).status).toBe(200);
  await setOk({ ...second, operationId: randomUUID(), retention: 'three years' });
  const unpublished = await publish(approved.versionId);
  expect({ status: unpublished.status, code: unpublished.code }).toEqual({
    status: 409,
    code: 'LEGAL_DATA_CLASSES_CHANGED',
  });
  expect((await readPolicy()).json).toEqual(one.json);
  // The other documents do not read the classes.
  const terms = await draft('client-terms');
  await setOk(dataClass());
  expect((await approve(terms)).status).toBe(200);
});

test('C81 data classes covered: a class not in use leaves the next policy, the records read sees what the policy sees, and the classes are written once', async () => {
  const kept = dataClass();
  await setOk(kept);
  const extra = dataClass();
  await setOk(extra);
  await setOk({ ...extra, operationId: randomUUID(), inUse: false });
  const policy = await releasePolicy();
  const classes = policy.json['dataClasses'] as readonly Record<string, unknown>[];
  expect(classes).toContainEqual(listed(kept));
  expect(classes.map((found) => found['dataClass'])).not.toContain(extra.dataClass);
  // C62's retention table and the request workflows read the register here.
  const read = await h().world.db.app.withBusiness(
    h().world.alpha,
    async (tx) => await readDataClasses(tx),
  );
  expect(read.listed).toEqual(classes);

  for (const edit of [
    `update public.legal_document_versions set data_classes = '[]'::jsonb where document = 'privacy-policy'`,
    `update public.legal_document_versions set data_classes_digest = md5('x') where document = 'privacy-policy'`,
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const refusal = await h()
      .world.db.app.withBusiness(h().world.alpha, async (tx) => await tx.query(edit))
      .then(() => 'applied', code);
    expect(refusal, edit).toBe('23001');
  }
});

test('C81 data class set: every change is tracked and audited, and one row stands per class in any letter case', async () => {
  const sent = dataClass();
  const detail = (await setOk(sent)).body['detail'] as Record<string, unknown>;
  const again = await set({
    ...sent,
    operationId: randomUUID(),
    dataClass: sent.dataClass.toUpperCase(),
  });
  expect(again.body['detail']).toEqual(detail);
  const audited = await h().world.db.app.withBusiness(
    h().world.alpha,
    async (tx) =>
      await tx.query<{ readonly n: number }>(
        `select count(*)::int as n from public.audit_events
          where command = 'privacy.set_data_class' and outcome = 'applied'
            and subject_record_id = $1`,
        [detail['dataClassId']],
      ),
  );
  expect(audited[0]?.n).toBe(2);
});

test('C81 data class set: malformed, NUL and lone-surrogate input and an undeclared field are refused, and nothing is written', async () => {
  const before = await classRows(h().world.alpha);
  for (const [body, field] of [
    [dataClass({ dataClass: 'x'.repeat(121) }), 'dataClass'],
    [dataClass({ purpose: 'x'.repeat(2001) }), 'purpose'],
    [dataClass({ deletion: [] }), 'deletion'],
    [dataClass({ inUse: 'yes' }), 'inUse'],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop
    const answer = await set(body);
    expect({ status: answer.status, code: answer.code }, field).toEqual({
      status: 422,
      code: 'FIELD_VALUE_INVALID',
    });
  }
  for (const field of FIELDS) {
    for (const bad of [`nul \u0000 ${CANARY}`, `lone \uD800 ${CANARY}`]) {
      // oxlint-disable-next-line no-await-in-loop
      const answer = await set(dataClass({ [field]: bad }));
      expect({ status: answer.status, code: answer.code }, field).toEqual({
        status: 422,
        code: 'FIELD_VALUE_INVALID',
      });
      expect(JSON.stringify(answer.body)).not.toContain(CANARY);
    }
  }
  const undeclared = await set({ ...dataClass(), region: 'Sydney' });
  expect({ status: undeclared.status, code: undeclared.code }).toEqual({
    status: 400,
    code: 'COMMAND_BODY_INVALID',
  });
  expect(await classRows(h().world.alpha)).toEqual(before);
});
