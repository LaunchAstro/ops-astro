// SPDX-License-Identifier: AGPL-3.0-only
//
// The published version of a legal document is the one published last
// (`readPublishedLegal`, newest `published_at`). The publication instant must
// be read when the publication is written, not when its transaction began: a
// publication whose transaction began first and was written after another
// committed is the current one. (Two publications written at once still stamp
// in the order they were written, not the order they commit: SEC-B1B F6.)
//
// Version 2.0's transaction begins and holds; version 1.0 is published and
// committed on another connection; then 2.0 is published and committed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  approveLegalVersion,
  draftLegalVersion,
  publishLegalVersion,
  readPublishedLegal,
} from '../../packages/core-records/src/operations/legal-documents.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const noop = (): void => undefined;

function gate(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open: () => void = noop;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe.skipIf(serverUrl === undefined)('legal publication order', () => {
  let db: FreshDatabase;
  let early: Database;
  let late: Database;
  let businessId: string;
  let actorId: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'legalorder' });
    early = connect(db.appUrl);
    late = connect(db.appUrl);
    businessId = await insertBusiness(db.app, 'legal-order');
    actorId = await db.app.withBusiness(
      businessId,
      async (tx) => await insertActor(tx, await insertPerson(tx, 'operator')),
    );
  }, 120_000);

  afterAll(async () => {
    await early?.close();
    await late?.close();
    await db?.drop();
  });

  it('the last legal publication is current when its transaction began before the earlier one', async () => {
    const versions = await db.app.withBusiness(businessId, async (tx) => {
      const first = await draftLegalVersion(
        tx,
        { document: 'client-terms', version: '1.0', body: 'First approved terms.' },
        actorId,
      );
      const last = await draftLegalVersion(
        tx,
        { document: 'client-terms', version: '2.0', body: 'Replacement approved terms.' },
        actorId,
      );
      if (first === undefined || last === undefined) throw new Error('both drafts must exist');
      expect(await approveLegalVersion(tx, first.id, first.digest, actorId)).toBeUndefined();
      expect(await approveLegalVersion(tx, last.id, last.digest, actorId)).toBeUndefined();
      return { first, last };
    });

    const begun = gate();
    const go = gate();
    const publishingLast = early.withBusiness(businessId, async (tx) => {
      await tx.query('select now()');
      begun.open();
      await go.promise;
      return await publishLegalVersion(tx, versions.last.id, actorId);
    });
    let first: unknown;
    try {
      await begun.promise;
      first = await late.withBusiness(
        businessId,
        async (tx) => await publishLegalVersion(tx, versions.first.id, actorId),
      );
    } finally {
      go.open();
    }
    const last = await publishingLast;

    const current = await db.app.withBusiness(
      businessId,
      async (tx) => await readPublishedLegal(tx, 'client-terms'),
    );
    expect({ first, last, current: current?.version }).toEqual({
      first: undefined,
      last: undefined,
      current: '2.0',
    });
  }, 30_000);
});
