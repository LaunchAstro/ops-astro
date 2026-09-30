// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1: the inbox read's cost (ORCH-DECISION 22:46Z, found by d06). The list
// and the owed count read what the caller can be shown: every open item, and
// the newest page of closed ones (50) about tasks the caller reads now. Access
// is checked for all of them in the read's own query, so neither read grows
// with a person's closed history.
//
// The timing case counts the queries each read makes, the cost that grew per
// row, and the rows the item query reads from the inbox and the records, from
// its own plan, rather than a wall clock that a loaded cluster would make
// flaky. The closed history is read newest first and the scan stops at the
// page: after the page's last readable item, or at the scan bound, whichever
// comes first, so the history behind it is never read. Closed items about a
// task the caller cannot read come back withheld and the list does not show
// them; inside the scan bound they leave no gap in the page.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem, type TenantQuery } from '../../packages/core-records/src/index.ts';
import { countOwed, readInbox } from '../../packages/core-commands/src/reads/inbox.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { enrol, type Member } from '../commands/fixture.ts';
import { authorised, BUSINESS_KEY, post, tokenFor } from '../api/fixture.ts';
import { clearingWorld, ok } from '../commands/inbox-clearing-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The newest closed entries the list carries (`INBOX_HISTORY_PAGE`). */
const PAGE = 50;

/** The most closed items one read looks at (`INBOX_HISTORY_SCAN`). */
const SCAN = 200;

type Entry = Readonly<Record<string, unknown>>;

interface PlanNode {
  readonly 'Relation Name'?: string;
  readonly 'Actual Rows': number;
  readonly 'Actual Loops': number;
  readonly 'Rows Removed by Filter'?: number;
  readonly Plans?: readonly PlanNode[];
}

/** The rows every node of `plan` read from `relation`, kept or filtered out, over all its loops. */
const rowsFrom = (plan: PlanNode, relation: string): number =>
  (plan['Relation Name'] === relation
    ? (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops']
    : 0) + (plan.Plans ?? []).reduce((sum, child) => sum + rowsFrom(child, relation), 0);

/** How many times the plan looked into `relation`: one lookup per loop of each node on it. */
const lookupsOn = (plan: PlanNode, relation: string): number =>
  (plan['Relation Name'] === relation ? plan['Actual Loops'] : 0) +
  (plan.Plans ?? []).reduce((sum, child) => sum + lookupsOn(child, relation), 0);

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('INB-1 the inbox read cost', () => {
  const w = clearingWorld('i1cost');
  const clientA = randomUUID();
  const clientB = randomUUID();
  let hana: Member;
  let hanaToken = '';
  let onA = '';
  let onB = '';

  const inAlpha = async <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
    await w.fixture.db.app.withBusiness(w.fixture.business, work);

  const task = async (title: string, client: string): Promise<string> => {
    const id = String(ok(await w.call('task.create', { fields: { title } })).body['recordId']);
    await w.fixture.db.admin.execute(
      `update public.records set data = data || jsonb_build_object('client', $2::text)
        where id = $1`,
      [id, client],
    );
    return id;
  };

  /** `count` closed items for Hana on `taskId`, each closed a second apart, newest `newest`s ago. */
  const history = async (taskId: string, count: number, newest: number): Promise<void> => {
    await w.fixture.db.admin.execute(
      `insert into public.inbox_items
         (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id,
          owed, work_state, raised_at, closed_at)
       select $1, gen_random_uuid(), $2, $3, 'mention', 'record', gen_random_uuid(), true,
              'withdrawn', now() - make_interval(secs => $5 + g + 1), now() - make_interval(secs => $5 + g)
         from generate_series(1, $4) as g`,
      [w.fixture.business, hana.personId, taskId, count, newest],
    );
  };

  const listed = async (): Promise<readonly Entry[]> =>
    ok(
      await post(w.api, `/api/b/${BUSINESS_KEY}${pathOf('inbox.read')}`, {}, authorised(hanaToken)),
    ).body['inbox'] as Entry[];

  /**
   * The queries each read makes for Hana, counted on the real transaction, and
   * the rows the item query read, from its plan run again with its own values.
   */
  const cost = async (): Promise<{
    read: number;
    count: number;
    owed: number;
    itemRows: number;
    recordRows: number;
    recordLookups: number;
  }> =>
    await inAlpha(async (tx) => {
      let queries = 0;
      let items: { sql: string; parameters: readonly unknown[] | undefined } | undefined;
      const counted: TenantQuery = {
        businessId: tx.businessId,
        query: async (sql, parameters) => {
          queries += 1;
          if (items === undefined && sql.includes('"raisedAt"')) items = { sql, parameters };
          return await tx.query(sql, parameters);
        },
      };
      await readInbox(counted, hana.personId);
      const read = queries;
      const owed = await countOwed(counted, hana.personId);
      if (items === undefined) throw new Error('the inbox read made no item query');
      const [explained] = await tx.query<{ 'QUERY PLAN': readonly [{ Plan: PlanNode }] }>(
        `explain (analyze, format json) ${items.sql}`,
        items.parameters as unknown[],
      );
      const plan = explained?.['QUERY PLAN'][0].Plan;
      if (plan === undefined) throw new Error('the item query has no plan');
      return {
        read,
        count: queries - read,
        owed,
        itemRows: rowsFrom(plan, 'inbox_items'),
        recordRows: rowsFrom(plan, 'records'),
        recordLookups: lookupsOn(plan, 'records'),
      };
    });

  beforeAll(async () => {
    hana = await enrol(w.fixture.db.app, w.fixture.business, 'Hana History');
    hanaToken = await tokenFor(hana.presented.subject);
    await inAlpha(async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: hana.personId },
        scope: { kind: 'party', id: clientA },
        collection: 'task',
        action: 'read',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: w.fixture.member.actorId,
      });
      if (!issued.ok) throw new Error(`grant: ${issued.refusal.code}`);
    });
    onA = await task('client A history', clientA);
    onB = await task('client B history', clientB);
    await inAlpha(
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: hana.personId,
          subjectRecordId: onA,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
    );
  }, 120_000);

  it('INB-1 timing: the list and the count make the same queries and read the same rows for a long closed history as a short one', async () => {
    // A short history just past the page, then 600 older items, half of them
    // about a task Hana cannot read.
    await history(onA, PAGE + 5, 10_000);
    const short = await cost();
    await history(onA, 300, 20_000);
    await history(onB, 300, 30_000);
    const long = await cost();
    expect(long.owed).toBe(1);
    expect(long).toStrictEqual(short);
    // The open item, the page, and the one row read to see the page is full.
    expect(long.itemRows).toBeGreaterThan(PAGE);
    expect(long.itemRows).toBeLessThanOrEqual(1 + PAGE + 1);
    // One lookup of the task per item read (rows per lookup are the
    // planner's business on a small table; the equality above holds them).
    expect(long.recordLookups).toBeLessThanOrEqual(1 + PAGE + 1);
  }, 60_000);

  it('INB-1 the list carries every open item and the newest page of readable closed ones, with no gap for withheld ones', async () => {
    // The newest closed history is on client B, which Hana cannot read.
    await history(onB, PAGE, 1);
    await history(onA, PAGE + 10, 5_000);
    const entries = await listed();
    const open = entries.filter((e) => e['workState'] === 'open');
    const closed = entries.filter((e) => e['workState'] !== 'open');
    expect(open).toHaveLength(1);
    expect(closed).toHaveLength(PAGE);
    expect(closed.every((e) => e['access'] === 'readable' && e['subjectRecordId'] === onA)).toBe(
      true,
    );
    expect(JSON.stringify(entries)).not.toContain(onB);
    // The page is the newest readable closed items, straight from the table.
    const newest = await w.fixture.db.admin.execute<{ id: string }>(
      `select id from public.inbox_items
        where recipient_person_id = $1 and subject_record_id = $2 and work_state <> 'open'
        order by closed_at desc, id desc limit $3`,
      [hana.personId, onA, PAGE],
    );
    expect(closed.map((e) => String(e['id'])).toSorted()).toStrictEqual(
      newest.map((row) => row.id).toSorted(),
    );
  }, 60_000);

  it('INB-1 timing: a long run of withheld history stops the read at the scan bound', async () => {
    // The newest thousand closed items are all about a task Hana cannot read.
    await history(onB, 1_000, 0);
    const bounded = await cost();
    expect(bounded.owed).toBe(1);
    expect(bounded.itemRows).toBeLessThanOrEqual(1 + SCAN + 1);
    expect(bounded.recordLookups).toBeLessThanOrEqual(1 + SCAN + 1);
    expect(JSON.stringify(await listed())).not.toContain(onB);
  }, 60_000);
});
