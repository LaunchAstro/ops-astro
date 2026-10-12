// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { changed, fingerprint, undeclared } from '../operations/s0-5-effect-diff.ts';
import { must, wayfinderWorld, type Decider, type Member, type WayfinderWorld } from './world.ts';

describe.skipIf(databaseUrlFromEnvironment() === undefined)(
  'another writer moving a map frontier',
  // eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
  () => {
    let w: WayfinderWorld;
    let owner: Decider;
    let writer: Member;

    beforeAll(async () => {
      w = await wayfinderWorld('frontierother', 'frontierother');
      owner = await w.decider('owner');
      writer = await w.member('other writer', ['read', 'write']);
      // Negative control in this suite's disposable database only. All code is
      // from the assigned head; disabling its sole new trigger restores the
      // pre-fix behaviour of generic task writes.
      if (process.env['SOL_1388_WITHOUT_TRIGGER'] === '1') {
        await w.db.admin.execute(
          'alter table public.map_frontier disable trigger map_frontier_raises_decision',
        );
      }
    }, 180_000);
    afterAll(async () => await w?.drop());

    async function blocked(type: 'grilling' | 'prototype') {
      const answer = await w.as(owner, {
        command: 'map.chart',
        title: 'Sol map',
        tickets: [
          { ref: 'a', title: 'research', type: 'research' },
          { ref: 'g', title: 'decision', type, blockedBy: ['a'] },
        ],
      });
      must(answer, 'map.chart');
      const tickets = (answer as unknown as { detail: { tickets: Record<string, string> } }).detail
        .tickets;
      return { a: tickets['a']!, g: tickets['g']! };
    }

    async function decisions(ticket: string) {
      return Array.from(
        await w.db.admin.execute<{ business: string; recipient: string }>(
          `select business_id::text as business, recipient_person_id::text as recipient
       from public.inbox_items where subject_record_id = $1 and reason = 'decision'`,
          [ticket],
        ),
        (row) => ({ ...row }),
      );
    }

    it.each(['grilling', 'prototype'] as const)(
      'another writer completing a blocker raises the owner decision for %s',
      async (type) => {
        const { a, g } = await blocked(type);
        expect(await decisions(g)).toEqual([]);
        must(
          await w.as(writer, {
            command: 'task.complete',
            recordId: a,
            expectedRevision: await w.revisionOf(a),
          }),
          'task.complete by other writer',
        );
        expect(await decisions(g)).toEqual([{ business: w.business, recipient: owner.personId }]);
      },
    );

    it.each(['task.complete', 'task.trash'] as const)(
      '%s declares its frontier decision write',
      async (command) => {
        const { a, g } = await blocked('grilling');
        expect(await decisions(g)).toEqual([]);
        const before = await fingerprint(w.db.admin);
        must(
          await w.as(writer, {
            command,
            recordId: a,
            expectedRevision: await w.revisionOf(a),
          }),
          command,
        );
        const written = changed(before, await fingerprint(w.db.admin));
        // Only this PR's new write: generic writes already changed map read
        // models before this PR, so those pre-existing omissions are excluded.
        expect(
          undeclared(
            command,
            written.filter((table) => table === 'inbox_items'),
          ),
        ).toEqual([]);
      },
    );
  },
);
