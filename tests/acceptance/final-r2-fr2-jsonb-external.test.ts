// SPDX-License-Identifier: AGPL-3.0-only
//
// FR2-JSONB, R2-AUTHORITY-36 (P3): an external party holding a read share and
// a provisioned record-scoped `comment` grant may write a client comment
// (AUTHORITY.md R4 ruling), and `task.comment` requires `expectedRevision`
// (API.md). Nothing the party can read carries the revision: `sharedTask` is
// `{ id, fields, comments }`. A comment without one is refused
// `EXPECTED_REVISION_REQUIRED` at the envelope (the finding named
// `VERSION_STALE` at `prepare.ts:481`; that is the answer to a guessed one),
// and both fixes say to read the record for the revision. So the permitted
// write is reachable only by guessing a revision and copying the real one out
// of the `VERSION_STALE` refusal's names.
//
// Reproduced at 3eb0cc1, and not fixed in this lane: the fix is the shared
// read's projection (`reads/tasks.ts`, `readSharedTask`), outside this lane's
// files, and handed back. The first case pins what the party sees today; the
// second is the permitted write made from the party's own reads alone, which
// fails until the projection carries the revision.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Caller,
  type World,
} from './world.ts';

describe.skipIf(serverUrl === undefined)(
  'R2-AUTHORITY-36: an external comment from its own reads',
  () => {
    let world: World;
    let ext: Caller;
    let shared: string;

    const as = async (who: Caller, name: CommandName, body: Record<string, unknown>) =>
      await call(world.api, personPath('alpha', pathOf(name)), body, bearer(who.token));

    beforeAll(async () => {
      world = await createWorld('fr2_jsonb_external');
      ext = await enrolExternal(world);
      const made = await as(world.ada, 'task.create', {
        operationId: randomUUID(),
        fields: { title: 'shared for comment' },
      });
      expect(made.code).toBe('ok');
      shared = String(made.body['recordId']);
      await world.db.app.withBusiness(world.alpha, async (tx) => {
        const issued = await issueGrant(
          tx,
          [{ kind: 'person', id: world.ada.personId as string }],
          {
            subject: { kind: 'person', id: ext.personId as string },
            scope: { kind: 'record', id: shared },
            collection: 'task',
            action: 'comment',
            parentGrantId: null,
            grantedByActorId: world.ada.actorId as string,
          },
        );
        expect(issued.ok).toBe(true);
        await shareRecord(
          tx,
          { personId: world.ada.personId as string, actorId: world.ada.actorId as string },
          { collection: 'task', recordId: shared, personId: ext.personId as string },
        );
      });
    });

    afterAll(async () => {
      await world?.close();
    });

    it("the party's read has no revision; the comment is reached only through a refusal's names", async () => {
      const read = await as(ext, 'task.read', { recordId: shared });
      expect(read.code).toBe('ok');
      const sharedTask = read.body['sharedTask'] as Record<string, unknown>;
      expect(Object.keys(sharedTask).toSorted()).toStrictEqual(['comments', 'fields', 'id']);
      const body = {
        recordId: shared,
        body: 'from the client',
        audience: 'client',
        commentType: 'client',
      };
      const without = await as(ext, 'task.comment', { operationId: randomUUID(), ...body });
      expect(without.code).toBe('EXPECTED_REVISION_REQUIRED');
      expect(without.body['fixes']).toContain(
        'Read the record and send the revision you are writing against as expected_revision.',
      );
      const guessed = await as(ext, 'task.comment', {
        operationId: randomUUID(),
        ...body,
        expectedRevision: 0,
      });
      expect(guessed.code).toBe('VERSION_STALE');
      const [named] = guessed.body['names'] as string[];
      const copied = Number(String(named).replace('revision=', ''));
      const landed = await as(ext, 'task.comment', {
        operationId: randomUUID(),
        ...body,
        expectedRevision: copied,
      });
      expect(landed.code).toBe('ok');
    });

    it.fails('the party comments using only what its own reads returned', async () => {
      const read = await as(ext, 'task.read', { recordId: shared });
      const sharedTask = read.body['sharedTask'] as Record<string, unknown>;
      const written = await as(ext, 'task.comment', {
        operationId: randomUUID(),
        recordId: sharedTask['id'],
        expectedRevision: sharedTask['revision'],
        body: 'from the client',
        audience: 'client',
        commentType: 'client',
      });
      expect(written.code).toBe('ok');
    });
  },
);
