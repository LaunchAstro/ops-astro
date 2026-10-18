// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, gap 4 and criterion 2: the door names a page as a person types it,
// and the server resolves it on the task's own site only, inside the insert.
// The exact address, or its last path segment in any case, names the one bound
// page; an unbound name, another client's page and an ambiguous name answer
// one body, byte for byte, storing nothing and telling no foreign id, address
// or count. The request carries no revision, file or digest: a body naming one
// is refused before anything is read. Crossings: another business's task,
// another client's grant, and an agent outside its delegation's task.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { bindPartySite } from '../../packages/core-records/src/index.ts';
import { ABOUT, PAGE, c80World, type C80World } from './c80-world.ts';
import { B_PAGE } from './c80-sites.ts';
import { freshClient, inAlpha } from './party-site-races.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('The door: DATABASE_URL is unset, so nothing ran.');

let w: C80World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('door');
}, 120_000);

const asked = (taskId: string, page: string) => ({
  command: 'live_correction.request',
  taskId,
  page,
  word: 'friendly',
  replacement: 'welcoming',
});

const stored = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        'select count(*)::text as n from public.live_corrections where task_id = $1',
        [taskId],
      )
    )[0]?.n,
  );

const rowOf = async (id: string) =>
  (
    await w.world.db.admin.execute<{
      readonly state: string;
      readonly page_url: string;
      readonly target_path: string;
      readonly base_revision: string | null;
      readonly version_id: string | null;
    }>(
      `select state, page_url, target_path, base_revision, version_id
         from public.live_corrections where id = $1`,
      [id],
    )
  )[0];

describe.skipIf(serverUrl === undefined)('the door names a page of the task’s own site', () => {
  it.each(['About', ' about ', PAGE])(
    'resolves %j to the one bound page, stored locating with no pins',
    async (page) => {
      const answer = await w.asRaw(w.ava, asked(w.taskA, page));
      if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
      expect(answer.detail).toStrictEqual({
        correctionId: answer.detail['correctionId'],
        state: 'locating',
      });
      expect(await rowOf(String(answer.detail['correctionId']))).toStrictEqual({
        state: 'locating',
        page_url: PAGE,
        target_path: ABOUT,
        base_revision: null,
        version_id: null,
      });
    },
  );
});

describe.skipIf(serverUrl === undefined)('the door names a page of the task’s own site', () => {
  it('answers an unbound name, another client’s page and an ambiguous name with one body', async () => {
    const client = await freshClient(w);
    // A second page of the fresh client's own site whose last segment is also `one`.
    const twin = { pageUrl: `${client.pages[0].pageUrl}nested/one/`, path: 'src/pages/twin.md' };
    const bound = await inAlpha(
      w,
      async (tx) => await bindPartySite(tx, { ...client.site, pages: [twin] }, w.admin.actorId),
    );
    expect(bound.ok).toBe(true);
    const marker = `marker-${randomUUID()}`;
    await w.world.db.admin.execute(
      `update public.records set data = jsonb_set(data, '{title}', to_jsonb($2::text)) where id = $1`,
      [w.taskB, marker],
    );
    const before = [await stored(w.taskA), await stored(client.taskId)];
    const bodies = [
      await w.asRaw(w.ava, asked(w.taskA, 'pricing')),
      await w.asRaw(w.ava, asked(w.taskA, 'team')),
      await w.asRaw(w.ava, asked(w.taskA, B_PAGE)),
      await w.asRaw(w.ava, asked(client.taskId, 'one')),
    ];
    for (const body of bodies) expect(codeOf(body)).toBe('NOT_FOUND');
    const texts = bodies.map((body) => JSON.stringify(body));
    expect(new Set(texts).size).toBe(1);
    for (const foreign of [w.partyB, w.taskB, B_PAGE, 'client-b', marker, client.partyId]) {
      expect(texts[0]).not.toContain(foreign);
    }
    expect([await stored(w.taskA), await stored(client.taskId)]).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('the door names a page of the task’s own site', () => {
  it('refuses a body naming a revision, a file, a digest or a party, storing nothing', async () => {
    const before = await stored(w.taskA);
    for (const extra of [
      { baseRevision: 'c0'.repeat(20) },
      { before: 'We are a friendly studio.' },
      { after: 'We are a welcoming studio.' },
      { path: ABOUT },
      { pageUrl: PAGE },
      { partyId: w.partyA },
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one body after another
      const answer = await w.asRaw(w.ava, { ...asked(w.taskA, 'About'), ...extra });
      expect(codeOf(answer)).toBe('COMMAND_BODY_INVALID');
    }
    expect(await stored(w.taskA)).toBe(before);
  });
});

describe.skipIf(serverUrl === undefined)('the door names a page of the task’s own site', () => {
  it('reaches no other business, client or delegation', async () => {
    // Another business's task: answered as a task that is not there.
    expect(codeOf(await w.asRaw(w.ava, asked(w.betaTask, 'About')))).toBe('NOT_FOUND');
    // A grant on client B only reaches nothing of client A's site.
    expect(codeOf(await w.asRaw(w.dee, asked(w.taskA, 'About')))).not.toBe('not-a-refusal');
    // An agent's delegation reaches only the task it was minted for.
    const picked = await w.pickUpUnder(w.ava, `door ${randomUUID()}`, w.partyA);
    const answer = await w.world.asAgent(
      { ...asked(w.taskA, 'About'), operationId: randomUUID() },
      picked.credential,
    );
    expect(codeOf(answer)).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(await stored(w.betaTask)).toBe(0);
  });
});
