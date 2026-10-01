// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite per read: each case is a checklist line on one shared world */
//
// API-4's *changes since* (#632): held. It returns only the tasks changed
// after a point the agent holds, from C4's live change record, which is built
// on slice/SL10-u26 (`changesSince(tx, subjects, point)` in core-records:
// `{ point, changes: [{ kind: 'task', id, changedAt }] }` or 'POINT_INVALID';
// a null point starts at now) and not on this branch (LEANS-ON SL10-7 U26).
// The cases are written against that shape and skipped until the rebase; the
// file is listed as deliberately unnamed, since the runner refuses a skip in
// a named suite. At the rebase: drop the skip, record the red run, build the
// read `task.changes` (operand `since`; the CLI verb `changes [--since <point>]`)
// on `changesSince`, name this file, and add the read to the quota suite and
// the pins listing every read.
//
// Open point for SL10-7: `changesSince` reads grants at business or record
// scope only, so a person granted a Wayfinder map (which covers its tickets,
// `prepare.ts` coveringMap, `reads/dispatch.ts`) gets no changes for them.
// The map-scoped case below fails until that is settled.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, must, type Member } from '../wayfinder/world.ts';
import { cliWorld, type CliWorld } from './api-3-world.ts';

/* eslint-disable no-await-in-loop -- each step reads the state the one before wrote */

const serverUrl = databaseUrlFromEnvironment();
/** Set false at the rebase that brings C4's change record in (SL10 U26). */
const HELD = true;

interface Changes {
  readonly point: string;
  readonly changes: readonly { readonly id: string; readonly changedAt: string }[];
}

const idsOf = (answer: unknown) => (answer as Changes).changes.map((change) => change.id);

describe.skipIf(HELD || serverUrl === undefined)(
  'API-4 changes since (held: LEANS-ON SL10-7 U26, the C4 live change record)',
  () => {
    let w: CliWorld;
    let lead: Member;

    const changes = async (who: Member, since?: string, onBravo = false) =>
      await w.read(
        who,
        { read: 'task.changes', ...(since === undefined ? {} : { since }) },
        onBravo ? w.bravo : w.business,
      );
    const point = async (who: Member) => (await changes(who)) as Changes;
    const retitle = async (who: Member, id: string, title: string) =>
      must(
        await w.as(who, {
          command: 'task.update',
          recordId: id,
          expectedRevision: await w.revisionOf(id),
          fields: { title },
        }),
        'task.update',
      );
    const chart = async (title: string) => {
      const answer = await w.as(lead, {
        command: 'map.chart',
        title,
        tickets: [
          { ref: 'a', title: `${title} a`, type: 'research' },
          { ref: 'b', title: `${title} b`, type: 'task' },
        ],
      });
      const map = must(answer, 'map.chart').id;
      const tickets = (answer as unknown as { detail: { tickets: Record<string, string> } }).detail
        .tickets;
      return { map, a: tickets['a'] as string, b: tickets['b'] as string };
    };

    beforeAll(async () => {
      w = await cliWorld('api4ch', 'apifourch');
      lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    }, 180_000);

    afterAll(async () => await w?.drop());

    it('API-4 changes since returns only records changed after the point, in one call', async () => {
      const { a, b } = await chart('since map');
      const start = await point(lead);
      expect(start.changes).toStrictEqual([]);
      await retitle(lead, a, 'since map a, retitled');
      const cli = await w.person(lead);
      const before = cli.requests();
      const answer = await cli.run('changes', '--since', start.point, '--json');
      expect(cli.requests() - before).toBe(1);
      expect(answer.exit).toBe(0);
      const ids = (JSON.parse(answer.out) as Changes).changes.map((change) => change.id);
      expect(ids).toContain(a);
      expect(ids).not.toContain(b);
    });

    it('API-4 changes since: a read after a write never shows the old state, and the point never goes back', async () => {
      const { a } = await chart('fresh map');
      const start = await point(lead);
      await retitle(lead, a, 'fresh map a, once');
      const first = (await changes(lead, start.point)) as Changes;
      expect(idsOf(first)).toContain(a);
      expect(BigInt(first.point) >= BigInt(start.point)).toBe(true);
      await retitle(lead, a, 'fresh map a, twice');
      const second = (await changes(lead, first.point)) as Changes;
      expect(idsOf(second)).toContain(a);
      expect(BigInt(second.point) >= BigInt(first.point)).toBe(true);
    });

    it('API-4 changes since refuses a malformed point before any query', async () => {
      for (const since of ['-1', 'abc', '1'.repeat(20), ' 1', '0x10']) {
        expect(codeOf(await changes(lead, since))).toBe('FIELD_VALUE_INVALID');
      }
    });

    it('API-4 changes since returns nothing the caller may not read, and a map grant covers its tickets', async () => {
      const mapA = await chart('granted map');
      const mapB = await chart('other map');
      const onA = await w.member('on-a', ['read'], { kind: 'record', id: mapA.map });
      const start = await point(onA);
      await retitle(lead, mapA.a, 'granted map a, retitled');
      await retitle(lead, mapB.a, 'other map a, retitled');
      const ids = idsOf(await changes(onA, start.point));
      expect(ids).not.toContain(mapB.a);
      // The map-scoped grant covers its tickets (open point for SL10-7).
      expect(ids).toContain(mapA.a);
    });

    it('API-4 isolation: changes since', async () => {
      const mapB = await chart('canary-map-B');
      must(
        await w.as(lead, {
          command: 'map.scope',
          recordId: mapB.map,
          expectedRevision: await w.revisionOf(mapB.map),
          client: randomUUID(),
        }),
        'scope',
      );
      const foreign = [mapB.map, mapB.a, mapB.b, 'canary-map-B'];
      const clean = (answer: unknown) => {
        const text = JSON.stringify(answer);
        for (const canary of foreign) expect(text).not.toContain(canary);
      };
      // 1. Another business sees none of this business's changes.
      const bea = await w.outsider('bea');
      const bravoStart = (await changes(bea, undefined, true)) as Changes;
      await retitle(lead, mapB.a, 'canary-map-B a, retitled');
      const bravo = await changes(bea, bravoStart.point, true);
      expect(idsOf(bravo)).toStrictEqual([]);
      clean(bravo);
      // 2. Another client's map in the same business, to a person granted map A only.
      const mapA = await chart('client A map');
      const onA = await w.member('on-a-iso', ['read'], { kind: 'record', id: mapA.map });
      const startA = await point(onA);
      await retitle(lead, mapB.b, 'canary-map-B b, retitled');
      const seen = await changes(onA, startA.point);
      clean(seen);
      // 3. An agent under a live delegation sees at most its own task.
      const picked = await w.pickUp(await w.decider('delegator'), 'delegated changes');
      const agent = await w.agent(picked.credential);
      const answer = await agent.run('changes', '--json');
      expect(answer.exit === 0 ? idsOf(JSON.parse(answer.out)) : []).not.toContain(mapB.a);
      clean(answer.out);
    });

    it('API-3 changes since writes exactly its one audit event', async () => {
      const reader = await w.member('audit-reader', ['read']);
      const none = await w.member('audit-none', []);
      const before = (await w.audit()).length;
      await changes(reader);
      expect(codeOf(await changes(none))).toBe('SCOPE_NOT_GRANTED');
      const lines = (await w.audit()).slice(before);
      expect(lines.map((line) => [line.command, line.outcome])).toStrictEqual([
        ['task.changes', 'applied'],
        ['task.changes', 'refused'],
      ]);
    });

    it.todo(
      'API-4 changes since is one query on the change record (count statements as api-4 does)',
    );
    it.todo('API-4 quota: changes since is charged like every call (as api-4-quota does)');
  },
);
