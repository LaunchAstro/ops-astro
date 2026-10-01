// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one world and its three crossings read as one suite */
//
// U09's Security lines over HTTP: the board machine sees only what `task.board`
// hands it, so every separation is proved at that read, and then again through
// the machine's own counts, presets, sorts, history and suggestions over the
// rows that came back. Three real crossings, statuses checked:
//
// - another business: bravo's member reads alpha's board, and her own;
// - another client in the same business: a client login holding a share of
//   one alpha task reads the board, and the task shared with another client;
// - another person under a live delegation: the agent holding ada's
//   delegation for one task reads the board.
//
// The withheld count (B-22, records-and-authority, 14 September): a member
// whose grants reach some of the board's rows sees those rows and how many
// others there are, never which. A client login sees no count at all.
//
// U13 (MP-5-7): the funnel's counts and the freshness stamp come only from
// the rows served, so a newer record in another business or on another
// client's task moves neither, and no refusal carries a stamp.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  pathOf,
  type CommandName,
  DELEGATION_HEADER,
} from '../../packages/core-wire/src/surface.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { mintDelegation } from '../../packages/core-records/src/index.ts';
import {
  funnelMenu,
  initialMachine,
  layoutColumns,
  rankFacets,
  narrowRows,
  presetCount,
  reduceBoard,
  sortRows,
  suggest,
  type BoardContext,
  type Facet,
} from '../../packages/ui/src/board/index.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Answer,
  type Caller,
  type World,
} from '../acceptance/world.ts';

interface Row {
  readonly id: string;
  readonly title: string;
}

const tag = randomUUID().slice(0, 8);
const TITLES = {
  noahs: `Noah may read this ${tag}`,
  hidden: `Zanzibar withheld canary ${tag}`,
  other: `Quokka second withheld ${tag}`,
  bravo: `Xylophone bravo canary ${tag}`,
} as const;

const rowsOf = (answer: Answer): readonly Row[] =>
  ((answer.body['tasks'] as { id: string; title: string | null }[] | undefined) ?? []).map(
    (task) => ({ id: task.id, title: task.title ?? '' }),
  );

const hay = (row: Row): string => row.title;

// eslint-disable-next-line max-lines-per-function -- one world, built once, and the crossings that share it
describe.skipIf(serverUrl === undefined)('MP-5 board reads across the three crossings', () => {
  let world: World;
  let ext1: Caller;
  let ext2: Caller;
  let credential: string;
  let noahsGrant: string;
  const ids: Record<keyof typeof TITLES, string> = { noahs: '', hidden: '', other: '', bravo: '' };

  const read = async (
    who: { readonly token: string },
    businessKey = 'alpha',
    name: CommandName = 'task.board',
    body?: Record<string, unknown>,
  ): Promise<Answer> =>
    await call(
      world.api,
      personPath(businessKey, pathOf(name)),
      body ?? { board: null },
      bearer(who.token),
    );

  const create = async (who: Caller, businessKey: string, title: string): Promise<string> => {
    const made = await read(who, businessKey, 'task.create', {
      operationId: randomUUID(),
      fields: { title },
    });
    if (made.code !== 'ok') throw new Error(`fixture: task.create refused ${made.code}`);
    return String(made.body['recordId']);
  };

  const share = async (recordId: string, party: Caller): Promise<void> => {
    const shared = await world.db.app.withBusiness(world.alpha, (tx) =>
      shareRecord(
        tx,
        { personId: world.ada.personId as string, actorId: world.ada.actorId as string },
        { collection: 'task', recordId, personId: party.personId as string },
      ),
    );
    if (!shared.ok) throw new Error(`fixture: share refused ${shared.refusal.code}`);
  };

  beforeAll(async () => {
    world = await createWorld('mp5_board');
    ids.noahs = await create(world.ada, 'alpha', TITLES.noahs);
    ids.hidden = await create(world.ada, 'alpha', TITLES.hidden);
    ids.other = await create(world.ada, 'alpha', TITLES.other);
    ids.bravo = await create(world.bea, 'bravo', TITLES.bravo);

    // Noah is a member with no business grant: one record-scoped read.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: world.noah.personId as string },
        scope: { kind: 'record', id: ids.noahs },
        collection: 'task',
        action: 'read',
        parentGrantId: null,
        grantedByActorId: world.ada.actorId as string,
      });
      if (!issued.ok) throw new Error(`fixture: grant refused ${issued.refusal.code}`);
      noahsGrant = issued.value;
    });

    // Two client logins, each shared one task.
    ext1 = await enrolExternal(world);
    ext2 = await enrolExternal(world);
    await share(ids.noahs, ext1);
    await share(ids.hidden, ext2);

    // The agent, under ada's live delegation for one task.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const minted = await mintDelegation(tx, {
        agentActorId: world.agent.actorId,
        delegatePersonId: world.ada.personId as string,
        mintedByActorId: world.ada.actorId as string,
        purpose: 'mp5_board',
        collections: ['task'],
        actions: ['read'],
        purposeScope: { kind: 'record', id: ids.noahs },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      if (!minted.ok) throw new Error(`fixture: mint refused ${minted.refusal.code}`);
      credential = minted.value.credential;
    });
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  const alphaBoardSize = async (): Promise<number> => {
    const rows = await world.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.records r
         join public.record_types t on t.id = r.record_type_id and t.business_id = r.business_id
        where r.business_id = $1 and t.key = 'task' and r.deleted_at is null and r.uuid_5 is null`,
      [world.alpha],
    );
    return rows[0]?.n ?? -1;
  };

  /** Nothing identifying of these tasks anywhere in the body, refusals included. */
  const expectNoneOf = (answer: Answer, keys: readonly (keyof typeof TITLES)[]): void => {
    const text = JSON.stringify(answer.body);
    for (const key of keys) {
      expect(text, `${key}'s id`).not.toContain(ids[key]);
      expect(text, `${key}'s title`).not.toContain(TITLES[key]);
    }
  };

  /** The three crossings; each returns the rows the crossing reader was handed. */
  const crossings = async (): Promise<readonly (readonly Row[])[]> => {
    // Another business: alpha's board on bravo's credential, then bravo's own.
    const intoAlpha = await read(world.bea, 'alpha');
    expect(intoAlpha.status).toBe(403);
    expect(intoAlpha.code).toBe('AUTH_NO_MEMBERSHIP');
    expectNoneOf(intoAlpha, ['noahs', 'hidden', 'other']);
    expect(intoAlpha.body).not.toHaveProperty('withheld');
    expect(intoAlpha.body).not.toHaveProperty('changedAt');
    const own = await read(world.bea, 'bravo');
    expect(own.status).toBe(200);
    expect(own.body['withheld']).toBe(0);
    expectNoneOf(own, ['noahs', 'hidden', 'other']);

    // Another client in the same business: no board, no count, no sibling.
    const board = await read(ext1);
    expect(board.status).toBe(404);
    expect(board.code).toBe('NOT_FOUND');
    expect(board.body).not.toHaveProperty('withheld');
    expect(board.body).not.toHaveProperty('changedAt');
    expectNoneOf(board, ['noahs', 'hidden', 'other', 'bravo']);
    const theirs = await read(ext1, 'alpha', 'task.read', { recordId: ids.hidden });
    expect(theirs.status).toBe(404);
    expectNoneOf(theirs, ['hidden']);

    // Another person under a live delegation: the agent reads no board.
    const agent = await call(
      world.api,
      agentPath('alpha', pathOf('task.board')),
      { operationId: randomUUID(), board: null },
      { ...bearer(world.agent.token), [DELEGATION_HEADER]: credential },
    );
    expect(agent.status).toBe(403);
    expect(agent.code).toBe('DELEGATION_EXCLUDES_OPERATION');
    expect(agent.body).not.toHaveProperty('withheld');
    expect(agent.body).not.toHaveProperty('changedAt');
    expectNoneOf(agent, ['noahs', 'hidden', 'other', 'bravo']);

    return [rowsOf(own), rowsOf(board), rowsOf(agent)];
  };

  const facets = (rows: readonly Row[]): readonly Facet<Row>[] =>
    rows.map((row) => ({
      id: `name:${row.id}`,
      kind: 'Name',
      label: row.title,
      words: row.title.toLowerCase().split(' '),
      test: (candidate: Row) => candidate.id === row.id,
    }));
  const context = (rows: readonly Row[]): BoardContext<Row> => ({
    facets: facets(rows),
    columns: [
      {
        key: 'title',
        label: 'Task name',
        share: 1,
        min: 80,
        labelWidth: 60,
        align: 'start',
        sortValue: hay,
      },
    ],
    presets: [{ id: 'all', label: 'All', facetIds: facets(rows).map((facet) => facet.id) }],
    modes: [],
  });
  const alphaCanaries = (text: string): void => {
    for (const title of [TITLES.noahs, TITLES.hidden, TITLES.other])
      expect(text).not.toContain(title);
  };

  it('MP-5-3 withheld count canary', async () => {
    // A member holding task:read on the whole collection is told the count
    // (SL07-B22-ANSWER); the collection grant reaches every task, so it is 0.
    const mia = await read(world.mia);
    expect(mia.status).toBe(200);
    expect(mia.body['withheld']).toBe(0);
    expect(rowsOf(mia)).toHaveLength(await alphaBoardSize());
    expectNoneOf(mia, ['bravo']);
    // Another business's tasks are neither listed nor counted.
    const bea = await read(world.bea, 'bravo');
    expect(bea.body['withheld']).toBe(0);
    expectNoneOf(bea, ['noahs', 'hidden', 'other']);
    // Nobody with no grant at all is told a count.
    const orphan = await read(world.orphan);
    expect(orphan.status).toBeGreaterThanOrEqual(400);
    expect(orphan.body).not.toHaveProperty('withheld');
  });

  it('MP-5-3 record-scoped member gets no count', async () => {
    // Noah's task:read is one record grant: a client login under owner answer
    // 22. The board holds another client's task (shared with ext2); he gets
    // his own task, no count field, and nothing of theirs anywhere.
    const answer = await read(world.noah);
    expect(answer.status).toBe(200);
    expect(rowsOf(answer).map((row) => row.id)).toEqual([ids.noahs]);
    expect(answer.body).not.toHaveProperty('withheld');
    expect(JSON.stringify(answer.body)).not.toMatch(/withheld/u);
    expectNoneOf(answer, ['hidden', 'other', 'bravo']);
  });

  it('MP-5-3 client login count', async () => {
    for (const party of [ext1, ext2]) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await read(party);
      expect(answer.status).toBe(404);
      expect(answer.body).not.toHaveProperty('withheld');
      expect(JSON.stringify(answer.body)).not.toMatch(/withheld|\b[0-9]+ more\b/u);
      expectNoneOf(answer, ['noahs', 'hidden', 'other', 'bravo']);
    }
  });

  it('MP-5-5 scope canary', async () => {
    const noah = rowsOf(await read(world.noah));
    const bea = rowsOf(await read(world.bea, 'bravo'));
    for (const [rows, q] of [
      [noah, 'zanzibar'],
      [noah, 'xylophone'],
      [bea, 'noah'],
      [bea, 'quokka'],
    ] as const) {
      const groups = suggest({
        q,
        facets: facets(rows),
        names: rows.map((row) => hay(row)),
        noun: 'task',
        have: { ids: [], text: [] },
      });
      expect(groups, q).toEqual([]);
    }
    // The viewer's own rows are suggested, so the empty answers above are about scope.
    expect(
      suggest({
        q: 'noah',
        facets: [],
        names: noah.map((row) => hay(row)),
        noun: 'task',
        have: { ids: [], text: [] },
      }),
    ).toHaveLength(1);
  });

  it('MP-5-1 isolation', async () => {
    for (const rows of await crossings()) {
      const laid = layoutColumns(context(rows).columns, { viewport: 1480, available: 1200 });
      expect(laid.columns).toHaveLength(1);
      alphaCanaries(JSON.stringify(rows));
    }
  });

  it('MP-5-2 isolation', async () => {
    for (const rows of await crossings()) {
      const sorted = sortRows(rows, { key: 'title', dir: 'asc' }, context(rows).columns);
      expect(sorted).toHaveLength(rows.length);
      alphaCanaries(JSON.stringify(sorted));
    }
  });

  it('MP-5-3 isolation', async () => {
    for (const rows of await crossings()) {
      const board = context(rows);
      const preset = board.presets[0];
      if (preset === undefined) throw new Error('fixture: no preset');
      expect(presetCount(rows, preset, board.facets, hay)).toBe(rows.length);
      alphaCanaries(
        JSON.stringify(narrowRows(rows, { ids: [], text: ['zanzibar'] }, board.facets, hay)),
      );
      alphaCanaries(JSON.stringify(board.facets.map((facet) => facet.label)));
    }
  });

  it('MP-5-4 isolation', async () => {
    for (const rows of await crossings()) {
      const board = context(rows);
      let machine = reduceBoard(initialMachine(), { type: 'commit', raw: 'zanzibar noah' }, board);
      machine = reduceBoard(machine, { type: 'undo' }, board);
      machine = reduceBoard(machine, { type: 'redo' }, board);
      alphaCanaries(JSON.stringify(machine));
      alphaCanaries(JSON.stringify(narrowRows(rows, machine.view, board.facets, hay)));
    }
  });

  it('MP-5-5 isolation', async () => {
    for (const rows of await crossings()) {
      for (const q of ['noah', 'zanzibar', 'quokka']) {
        const groups = suggest({
          q,
          facets: facets(rows),
          names: rows.map((row) => hay(row)),
          noun: 'task',
          have: { ids: [], text: [] },
        });
        alphaCanaries(JSON.stringify(groups));
      }
    }
  });
  /** Rewrite a task as it stands, so the trigger stamps it now. */
  const touch = async (businessId: string, recordId: string): Promise<string> => {
    await world.db.app.withBusiness(businessId as World['alpha'], (tx) =>
      tx.query(`update public.records set txt_4 = txt_4 where business_id = $1 and id = $2`, [
        businessId,
        recordId,
      ]),
    );
    const rows = await world.db.admin.execute<{ readonly at: Date }>(
      `select updated_at as at from public.records where id = $1`,
      [recordId],
    );
    const at = rows[0]?.at;
    if (at === undefined) throw new Error('fixture: touched task not found');
    return at.toISOString();
  };

  /** Filters over every canary title, so a count could only come from a row. */
  const everyTitle: readonly Facet<Row>[] = (Object.keys(TITLES) as (keyof typeof TITLES)[]).map(
    (key) => ({
      id: `title:${key}`,
      kind: 'Title',
      label: TITLES[key],
      test: (row: Row) => row.title === TITLES[key],
    }),
  );

  it('MP-5-7 counts in scope', async () => {
    // Noah's task changes first; then another client's task and bravo's, later.
    const noahs = await touch(world.alpha, ids.noahs);
    const hidden = await touch(world.alpha, ids.hidden);
    const bravo = await touch(world.bravo, ids.bravo);
    expect(hidden > noahs && bravo > hidden).toBe(true);

    // The record-scoped member: his stamp is his own task's; the newer ones
    // move nothing, and a count over his rows holds only his row.
    const noah = await read(world.noah);
    expect(noah.status).toBe(200);
    expect(noah.body['changedAt']).toBe(noahs);
    expectNoneOf(noah, ['hidden', 'other', 'bravo']);
    const counts = Object.fromEntries(
      rankFacets(rowsOf(noah), everyTitle).map((one) => [one.id, one.count]),
    );
    expect(counts).toEqual({
      'title:noahs': 1,
      'title:hidden': 0,
      'title:other': 0,
      'title:bravo': 0,
    });

    // A collection-wide reader sees alpha's newest, and never bravo's.
    const ada = await read(world.ada);
    expect(ada.body['changedAt']).toBe(hidden);
    const adaCounts = rankFacets(rowsOf(ada), everyTitle);
    expect(adaCounts.find((one) => one.id === 'title:bravo')?.count).toBe(0);
    // Bravo's board is stamped by bravo's task alone.
    const bea = await read(world.bea, 'bravo');
    expect(bea.body['changedAt']).toBe(bravo);
    expectNoneOf(bea, ['noahs', 'hidden', 'other']);
  });

  it('MP-5-7 isolation', async () => {
    for (const rows of await crossings()) {
      const ranked = rankFacets(rows, [...facets(rows), ...everyTitle]);
      for (const one of ranked) {
        if (one.id.startsWith('title:')) {
          const mine = rows.some((row) => row.title === one.label);
          expect(one.count).toBe(mine ? 1 : 0);
        }
      }
      const menu = funnelMenu(ranked, '', true);
      const listed = menu.groups.flatMap((group) => group.facets);
      for (const one of listed.filter((facet) => facet.kind !== 'Title')) {
        alphaCanaries(one.label);
      }
      alphaCanaries(JSON.stringify(rows));
    }
  });

  it('MP-5-3 withheld board lookups stay in-tenant and grant-first', async () => {
    // A named board Noah cannot read is refused as `task.read` refuses it.
    const unreadable = await read(world.noah, 'alpha', 'task.board', { board: ids.hidden });
    expect(unreadable.status).toBe(403);
    expect(unreadable.code).toBe('SCOPE_NOT_GRANTED');
    expect(unreadable.body).not.toHaveProperty('withheld');
    expectNoneOf(unreadable, ['hidden', 'other']);
    // Once his last grant goes, the board refuses him before any lookup: a
    // real board and a made-up one get the same answer.
    await world.db.app.withBusiness(world.alpha, (tx) => revokeGrant(tx, noahsGrant));
    for (const board of [null, ids.hidden, randomUUID()]) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await read(world.noah, 'alpha', 'task.board', { board });
      expect(answer.status, String(board)).toBe(403);
      expect(answer.code).toBe('SCOPE_NOT_GRANTED');
      expect(answer.body).not.toHaveProperty('withheld');
      expectNoneOf(answer, ['noahs', 'hidden', 'other']);
    }
  });
});
