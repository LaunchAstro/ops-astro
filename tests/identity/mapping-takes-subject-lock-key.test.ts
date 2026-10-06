// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 (OW-028.2): the mapping trigger's subject lock is the key
// `lockLoginFactors` takes, the SHA-256 hex of the subject's UTF-8 bytes. A
// subject outside ASCII shows SQL and TypeScript digest the same bytes: while
// a live mapping of it is uncommitted, the TypeScript lock cannot be taken.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { lockLoginFactors } from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from './fixture.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'a live mapping holds the subject lock lockLoginFactors names, for a subject outside ASCII',
  async () => {
    const db = await createFreshDatabase({ part: 'mappingkey' });
    const wide = connect(db.appUrl, { max: 3 });
    const subject = `sujet-é-日本-${randomUUID()}`;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held!: () => void;
    const mapped = new Promise<void>((resolve) => {
      held = resolve;
    });
    let mapping: Promise<void> | undefined;
    try {
      const bravo = await insertBusiness(wide, `bravo-${randomUUID()}`);
      const other = await insertBusiness(wide, `other-${randomUUID()}`);
      mapping = wide.withBusiness(bravo, async (tx) => {
        const person = await insertPerson(tx, 'Mapped person');
        await insertMapping(
          tx,
          await insertLogin(tx, subject),
          person,
          await insertActor(tx, person),
        );
        held();
        await released;
      });
      await Promise.race([mapped, mapping]);
      const take = async () =>
        await wide.withBusiness(other, async (tx) => {
          await tx.query(`select set_config('lock_timeout', '300ms', true)`);
          await lockLoginFactors(tx, subject);
        });
      await expect(take(), 'the mapping holds the same key').rejects.toMatchObject({
        code: '55P03',
      });
      release();
      await mapping;
      await expect(take(), 'free once the mapping commits').resolves.toBeUndefined();
    } finally {
      release();
      await Promise.allSettled([mapping]);
      await wide.close();
      await db.drop();
    }
  },
);
