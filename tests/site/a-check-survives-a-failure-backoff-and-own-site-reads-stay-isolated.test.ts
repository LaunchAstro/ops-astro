// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proofs on #1922, round 1 (S1922-1, and its isolation control), copied with their
// assertions unchanged: a check that succeeds while a failed check's backoff commits keeps its
// stamp, and the own site's correction reads stay inside their business, client and person.
/* oxlint-disable max-lines-per-function, no-await-in-loop, max-statements -- Sol's proof, kept as written */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { c80World, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: C80World;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('backoff');
}, 120_000);
afterAll(async () => {
  await w?.world.db.drop();
});

describe.skipIf(serverUrl === undefined)('a check racing a failure, and own-site reads', () => {
  it('keeps a successful check that races a failed check’s backoff', async () => {
    const { pinLocated, checksFailed, stampVerified, dueCorrections } =
      await import('../../packages/core-records/src/site/locate.ts');
    const { freshClient, inAlpha, insertOn, held, seenWaiting } =
      await import('./party-site-races.ts');
    const { TEST_PIN } = await import('./located.ts');
    const client = await freshClient(w);
    const correction = await inAlpha(w, insertOn(w, client, client.pages[0]));
    if ('code' in correction) throw new Error('request refused');
    const site = {
      holder: client.partyId,
      repository: client.site.repository,
      defaultBranch: client.site.defaultBranch,
      project: client.site.project,
      pages: client.pages,
    };
    expect(
      await inAlpha(w, (tx) =>
        pinLocated(tx, site, { id: correction.id, versionId: crypto.randomUUID(), ...TEST_PIN }),
      ),
    ).toBe('pinned');
    // Seed the elapsed 15-second schedule, then let both passes read the due row.
    await w.world.db.admin.execute(
      `with replica as (select set_config('session_replication_role', 'replica', true))
     update public.live_corrections set next_check_at = null from replica where id = $1`,
      [correction.id],
    );
    for (let pass = 0; pass < 2; pass += 1) {
      const due = await inAlpha(w, (tx) => dueCorrections(tx, site.holder));
      expect(due.some((row) => row.id === correction.id)).toBe(true);
    }
    const failing = held(w, (tx) => checksFailed(tx, [correction.id]));
    await failing.ready;
    const successful = inAlpha(w, (tx) =>
      stampVerified(tx, site, correction.id, TEST_PIN.preImageDigest),
    ).then(
      (value) => ({ value }),
      (error) => ({ error: String(error) }),
    );
    const waited = await seenWaiting(w, /update public\.live_corrections/u);
    failing.release();
    await failing.done;
    expect(waited).toBe(true);
    expect(await successful).toEqual({ value: true });
  });

  it('keeps own-site correction reads inside their business, client and person', async () => {
    const { readCoveredDecision } =
      await import('../../packages/core-records/src/site/correction-decisions.ts');
    const task = await w.as(w.ava, { command: 'task.create', fields: { title: 'Own separation' } });
    if ('code' in task) throw new Error('task refused');
    const answer = await w.asRaw(w.ava, {
      command: 'live_correction.request',
      taskId: task.recordId,
      page: 'https://sol1922.example/about/',
      word: 'friendly',
      replacement: 'welcoming',
    });
    if ('code' in answer) throw new Error('request refused');
    const id = String(answer.detail['correctionId']);
    const read = (business: string, person: string) =>
      w.world.db.app.withBusiness(business, (tx) =>
        readCoveredDecision(tx, id, {
          subjects: [{ kind: 'person', id: person }],
          collection: 'run',
          action: 'write',
        }),
      );
    expect(await read(w.world.business, w.ava.personId)).toMatchObject({
      correctionId: id,
      state: 'locating',
      versionId: null,
    });
    expect(await read(w.world.business, w.dee.personId)).toBeUndefined();
    expect(await read(w.world.business, w.eve.personId)).toBeUndefined();
    expect(await read(w.beta, w.eve.personId)).toBeUndefined();
  });
});
