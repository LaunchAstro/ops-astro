// SPDX-License-Identifier: AGPL-3.0-only
//
// I09 and D01: the comment record type, its classifications, and the external
// projection that is an allowlist rather than a filter somebody maintains.
//
// The failure this guards against is the one the ledger names: an internal
// field or a team comment reaching the HTTP body and being hidden by the user
// interface. A projection built by removing what should not be there is one
// forgotten field away from a leak; this one is built by including what the
// catalogue marks shared, so a new field is invisible until somebody
// classifies it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMENT_SPINE,
  COMMENT_TYPE_KEY,
  externalCommentProjection,
  readTaskComments,
  writeComment,
  type StoredComment,
} from '../../packages/core-records/src/tasks/comments.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { domainModelConformance } from '../../packages/core-records/src/records/conformance.ts';
import { readFieldDefinitions } from '../../packages/core-records/src/records/field-store.ts';
import type { FieldDefinition } from '../../packages/core-records/src/records/fields.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { insertActor, insertPerson } from '../identity/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('task comments', () => {
  let db: FreshDatabase;
  let business: string;
  let commentTypeId: string;
  let taskTypeId: string;
  let actorId: string;
  let fields: readonly FieldDefinition[];

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2c' });
    business = await insertBusiness(db.app, 'alpha');
    await db.app.withBusiness(business, async (tx) => {
      const personId = await insertPerson(tx, 'Ada');
      actorId = await insertActor(tx, personId);
      const installed = await installTaskSpine(tx);
      commentTypeId = installed.taskCommentTypeId;
      taskTypeId = installed.taskTypeId;
      fields = await readFieldDefinitions(tx, commentTypeId);
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  describe('D01: every field of the shipped type is classified', () => {
    it('installs the comment type beside the task type', () => {
      expect(COMMENT_TYPE_KEY).toBe('task_comment');
      expect(fields.map((field) => field.key).toSorted()).toStrictEqual(
        COMMENT_SPINE.map((field) => field.key).toSorted(),
      );
    });

    it('gives every field a write mode, and no field the database default', () => {
      for (const field of fields) {
        expect(['generic', 'operation', 'system']).toContain(field.writeMode);
      }
      // A comment is not a form. Nothing on it is edited by the generic
      // editor: the body and its classification belong to `task.comment`, and
      // the rest is derived.
      expect(fields.filter((field) => field.writeMode === 'generic')).toStrictEqual([]);
    });

    it('names the owning operation of every operation-owned field', () => {
      for (const field of fields) {
        expect(field.owningOperations.length > 0).toBe(field.writeMode === 'operation');
      }
      const audience = fields.find((field) => field.key === 'audience');
      expect(audience?.owningOperations).toContain('task.comment');
    });

    it('classifies visibility on every field, and shares only some of them', () => {
      for (const field of fields) {
        expect(['internal', 'shared']).toContain(field.visibilityClass);
      }
      const shared = fields
        .filter((field) => field.visibilityClass === 'shared')
        .map((field) => field.key)
        .toSorted();
      expect(shared).toStrictEqual(['audience', 'author', 'body', 'comment_type', 'posted_at']);
    });
  });

  describe('D01: the conformance set reads the comment type too', () => {
    it('finds nothing wrong with the installed model', async () => {
      expect(await domainModelConformance(db.admin.execute)).toStrictEqual([]);
    });

    it('refuses to let a comment field lose its classification at all', async () => {
      await expect(
        db.admin.execute(
          `update public.field_defs set write_mode = null
            where record_type_id = $1 and key = 'body'`,
          [commentTypeId],
        ),
      ).rejects.toThrow(/not-null constraint/iu);
      await expect(
        db.admin.execute(
          `update public.field_defs set owning_operation = null
            where record_type_id = $1 and key = 'body'`,
          [commentTypeId],
        ),
      ).rejects.toThrow(/field_defs_operation_named/iu);
    });

    it('catches an unclassified comment field if the schema ever stops refusing one', async () => {
      // The schema is the first barrier and the test above is it. This is the
      // second: with the column's not-null lifted, the conformance set has to
      // find the unclassified field by itself, because a check constraint
      // somebody drops in a later migration must not take the assertion with
      // it.
      await db.admin.execute(`alter table public.field_defs alter column write_mode drop not null`);
      try {
        await db.admin.execute(
          `update public.field_defs set write_mode = null
            where record_type_id = $1 and key = 'body'`,
          [commentTypeId],
        );
        const findings = await domainModelConformance(db.admin.execute);
        expect(findings.map((finding) => finding.object)).toContain('task_comment.body');
      } finally {
        await db.admin.execute(
          `update public.field_defs set write_mode = 'operation'
            where record_type_id = $1 and key = 'body'`,
          [commentTypeId],
        );
        await db.admin.execute(
          `alter table public.field_defs alter column write_mode set not null`,
        );
      }
    });
  });

  describe('I09: the external projection', () => {
    let stored: readonly StoredComment[];

    beforeAll(async () => {
      await db.app.withBusiness(business, async (tx) => {
        const taskId = crypto.randomUUID();
        await tx.query(
          `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
          [business, taskId, taskTypeId, { title: 'the task' }],
        );
        await writeComment(tx, commentTypeId, {
          taskId,
          authorActorId: actorId,
          commentType: 'client',
          audience: 'client',
          body: 'sent to the client',
          source: 'app',
        });
        await writeComment(tx, commentTypeId, {
          taskId,
          authorActorId: actorId,
          commentType: 'note',
          audience: 'internal',
          body: 'the team only',
          source: 'app',
        });
        stored = await readTaskComments(tx, commentTypeId, taskId);
      });
    });

    it('stores both comments, because storage is not the allowlist', () => {
      expect(stored.length).toBe(2);
    });

    it('returns the client comment and never the internal one', () => {
      const external = externalCommentProjection(stored, fields);
      expect(external.length).toBe(1);
      expect(JSON.stringify(external)).not.toContain('the team only');
      expect(JSON.stringify(external)).toContain('sent to the client');
    });

    it('carries only the fields the catalogue classifies shared', () => {
      const [external] = externalCommentProjection(stored, fields);
      expect(Object.keys(external ?? {}).toSorted()).toStrictEqual([
        'audience',
        'author',
        'body',
        'comment_type',
        'id',
        'posted_at',
      ]);
      expect(Object.hasOwn(external ?? {}, 'source')).toBe(false);
      expect(Object.hasOwn(external ?? {}, 'edited_at')).toBe(false);
      expect(Object.hasOwn(external ?? {}, 'task')).toBe(false);
    });

    it('hides a field the moment its classification is taken away', () => {
      const withoutBody = fields.filter((field) => field.key !== 'body');
      const [external] = externalCommentProjection(stored, withoutBody);
      expect(Object.hasOwn(external ?? {}, 'body')).toBe(false);
      // The allowlist direction, stated: an unclassified field is absent, not
      // present-and-hidden.
      expect(JSON.stringify(external)).not.toContain('sent to the client');
    });
  });
});
