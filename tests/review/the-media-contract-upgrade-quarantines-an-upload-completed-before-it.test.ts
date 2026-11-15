// SPDX-License-Identifier: AGPL-3.0-only
//
// U89 (#2039, C73), Sol round 1 on #2484: the contract's migration on a database that already
// holds a media upload completed under #2038's table, before any admission existed. The
// upgrade applies, keeps the row, and admits it quarantined: it plays only once a scan passes.
// The pre-contract table is the current one with exactly this migration's columns dropped.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c35World, type C35World } from './c35-world.ts';
import { mediaStoreDouble } from './media-store-double.ts';
import { digestOf, mediaCalls } from './media-world.ts';
import { PNG_BYTES } from './media-fixtures.ts';
import { splitStatements } from '../../packages/core-records/src/tenancy/statements.ts';

const MIGRATION = 'migrations/20261114231600_review_media_contract.sql';
const CONTRACT_COLUMNS = [
  'refusal',
  'scan_state',
  'scan_engine',
  'scanned_at',
  'probe_codec',
  'probe_fps_num',
  'probe_fps_den',
  'probe_timecode',
  'probe_duration',
  'probe_timescale',
];

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C73 contract upgrade: DATABASE_URL is unset, so nothing below ran.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('c73upgrade');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C73 the contract upgrade', () => {
  it('C73 an upload completed before the contract is kept and admitted quarantined', async () => {
    const media = mediaCalls(w, mediaStoreDouble(16));
    const declared = {
      kind: 'image',
      type: 'image/png',
      codec: null,
      byteCount: PNG_BYTES.byteLength,
      digest: digestOf(PNG_BYTES),
    } as const;
    const held = await media.upload(w.ava, w.taskA, declared, PNG_BYTES);
    if (!('reviewId' in held.completed)) throw new Error('the upload completed');
    await w.world.db.admin.execute(
      `alter table public.review_media_assets
         ${CONTRACT_COLUMNS.map((column) => `drop column ${column} cascade`).join(', ')}`,
    );

    await w.world.db.admin.transaction(async (execute) => {
      for (const statement of splitStatements(readFileSync(MIGRATION, 'utf8')))
        // oxlint-disable-next-line no-await-in-loop -- a migration's statements run in order
        await execute(statement);
    });

    const rows = await w.world.db.admin.execute<Record<string, unknown>>(
      `select id, state, refusal, scan_state, scan_engine, probe_codec
         from public.review_media_assets where business_id = $1`,
      [w.world.business],
    );
    // The driver's rows are its own class: compare their fields as plain objects.
    expect(rows.map((row) => Object.fromEntries(Object.entries(row)))).toStrictEqual([
      {
        id: held.assetId,
        state: 'completed',
        refusal: null,
        scan_state: 'quarantined',
        scan_engine: null,
        probe_codec: null,
      },
    ]);
    expect(await media.sign(w.ava, held.assetId)).toStrictEqual({ code: 'ASSET_QUARANTINED' });
  });
});
