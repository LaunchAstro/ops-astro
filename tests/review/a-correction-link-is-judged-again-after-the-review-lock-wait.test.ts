// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- the lock wait and the expiry read top to bottom */
//
// C35-X (#2120), from Sol's round-1 proof on #2155, its assertions unchanged: a revision names a
// correction only where the receipts read reaches it, across a business, a client and a person,
// and judged again after the review's lock wait, so a task read that expires during the wait
// links nothing.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { c35xWorld, type C35XWorld } from './c35-x-world.ts';
import { PAGE, B_PAGE, B_FILE } from './c35-world.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connect, connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C35-X correction link authority: DATABASE_URL is unset.');

let w: C35XWorld;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35xWorld('c35xlinkauth');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

describe.skipIf(serverUrl === undefined)('C35-X the correction link authority', () => {
  it('a correction link holds the business, client and person boundaries of the receipts read', async () => {
    const a = String(detailOf(await w.request(w.ava))['correctionId']);
    const b = String(
      detailOf(await w.request(w.ava, { taskId: w.taskB, page: B_PAGE }))['correctionId'],
    );
    const beta = String(
      detailOf(
        await w.asIn(w.beta, w.eve, {
          command: 'live_correction.request',
          taskId: w.betaTask,
          page: PAGE,
          word: 'friendly',
          replacement: 'welcoming',
        }),
      )['correctionId'],
    );
    expect(beta).not.toBe('undefined');
    expect(codeOf(await w.open(w.ava, { correctionId: beta }))).toBe('NOT_FOUND');
    expect(codeOf(await w.open(w.ava, { correctionId: b }))).toBe('NOT_FOUND');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, w.fay, 'write', { kind: 'business', id: null }, false, 'run');
    });
    // Fay has review and run permissions but no task read; Dee has run only on client B.
    expect(codeOf(await w.open(w.fay, { correctionId: a }))).toBe('NOT_FOUND');
    await w.world.db.app.withBusiness(w.world.business, async (tx) => {
      await grantTo(tx, w.dee, 'write', { kind: 'business', id: null }, false, 'review');
    });
    expect(codeOf(await w.open(w.dee, { correctionId: a }))).toBe('NOT_FOUND');
    expect(
      codeOf(
        await w.open(w.dee, {
          taskId: w.taskB,
          pageUrl: B_PAGE,
          path: B_FILE,
          correctionId: b,
        }),
      ),
    ).toBe('not-a-refusal');
  });

  it('a task read expiring during the review lock wait saves no correction link', async () => {
    const correctionId = String(detailOf(await w.request(w.ava))['correctionId']);
    const first = detailOf(await w.open(w.ava));
    const before = await w.count('review_revisions', w.world.business);
    // Set up a short-lived grant before the command starts; authority then expires naturally.
    const grants = await w.world.db.admin.execute<{ id: string }>(
      `update public.grants set expires_at = clock_timestamp() + interval '1 second'
      where business_id = $1 and subject_id = $2 and collection = 'task'
        and action = 'read' and revoked_at is null returning id`,
      [w.world.business, w.ava.personId],
    );
    expect(grants.length).toBeGreaterThan(0);
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const adminUrl = new URL(databaseUrlFromEnvironment()!);
    adminUrl.pathname = '/' + w.world.db.name;
    const blockingConnection = connectAsAdmin(adminUrl.toString());
    const otherApp = connect(w.world.db.appUrl);
    const blocker = blockingConnection.transaction(async (query) => {
      await query('select id from public.reviews where id = $1 for update', [first['reviewId']]);
      locked();
      await gate;
    });
    await ready;
    let settled = false;
    const opening = w.open(w.ava, { correctionId }).then((answer) => {
      settled = true;
      return answer;
    });
    try {
      await expect
        .poll(
          async () => {
            const rows = await w.world.db.admin.execute<{ n: string }>(
              `select count(*)::text as n from pg_stat_activity
          where datname = $1 and wait_event_type = 'Lock'
            and query like '%public.reviews%' and query like '%for update%'`,
              [w.world.db.name],
            );
            return settled || Number(rows[0]?.n) > 0;
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      if (!settled) {
        await expect
          .poll(
            async () => {
              const rows = await w.world.db.admin.execute<{ expired: boolean }>(
                `select bool_and(expires_at < clock_timestamp()) as expired
             from public.grants where id = any($1::uuid[])`,
                [grants.map((grant) => grant.id)],
              );
              return rows[0]?.expired;
            },
            { timeout: 5_000 },
          )
          .toBe(true);
        const read = await executeRead(otherApp, w.world.business, w.ava.presented, {
          read: 'live_correction.receipts',
          correctionId,
        });
        expect(read).toMatchObject({ code: 'NOT_FOUND' });
      }
    } finally {
      release();
      await blocker;
      await blockingConnection.close();
      await otherApp.close();
    }
    const answer = await opening;
    expect({
      code: codeOf(answer),
      revisions: await w.count('review_revisions', w.world.business),
    }).toMatchObject({ revisions: before });
    expect(codeOf(answer)).not.toBe('not-a-refusal');
  });
});
