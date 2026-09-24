// SPDX-License-Identifier: AGPL-3.0-only
//
// FR2-JSONB, R2-AUTHORITY-36 (P3): an external party holding a read share and
// a provisioned record-scoped `comment` grant may write a client comment
// (AUTHORITY.md R4 ruling), and `task.comment` requires `expectedRevision`
// (API.md). At 3eb0cc1 nothing the party could read carried the revision
// (`sharedTask` was `{ id, fields, comments }`), so the permitted write was
// reachable only by guessing a revision and copying the real one out of a
// `VERSION_STALE` refusal's names. With no revision the answer is
// `EXPECTED_REVISION_REQUIRED` at the envelope, and both fixes say to read
// the record for it.
//
// Fixed in FR2-JSONB-CONT (lead ruling): the shared read carries the record's
// `revision`, and no other key changed.

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

    it("the party's read carries the revision and exactly the shared keys", async () => {
      const read = await as(ext, 'task.read', { recordId: shared });
      expect(read.code).toBe('ok');
      const sharedTask = read.body['sharedTask'] as Record<string, unknown>;
      expect(Object.keys(sharedTask).toSorted()).toStrictEqual([
        'comments',
        'fields',
        'id',
        'revision',
      ]);
      const owner = (await as(world.ada, 'task.read', { recordId: shared })).body['task'] as {
        readonly revision: number;
      };
      expect(sharedTask['revision']).toBe(owner.revision);
    });

    it('a comment without a revision is still EXPECTED_REVISION_REQUIRED', async () => {
      const written = await as(ext, 'task.comment', {
        operationId: randomUUID(),
        recordId: shared,
        body: 'from the client',
        audience: 'client',
        commentType: 'client',
      });
      expect(written.code).toBe('EXPECTED_REVISION_REQUIRED');
    });

    it('the party comments using only what its own reads returned', async () => {
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
      const after = await as(ext, 'task.read', { recordId: shared });
      const comments = (after.body['sharedTask'] as { comments: { body: string }[] }).comments;
      expect(comments.map((comment) => comment.body)).toContain('from the client');
    });
  },
);
