// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations this lane added, reached the way a caller reaches them:
// over HTTP, through the real Hono app, against a real Postgres.
//
// `boundary.test.ts` substitutes the database because its questions are the
// transport's. These questions are the other half — whether the generated
// route really carries the operation, and whether the refusal a caller is
// shown has the status the register decided — and neither can be answered
// against a stub. So the app is built over `createFreshDatabase` and every
// case below is one request and one response.
//
// One positive and one refusal for each of the four: `task.comment`,
// `preset.plan`, `settings.set_four_eyes_threshold` and
// `settings.set_client_sign_off`. Nothing here constructs a route by hand —
// the path comes from `pathOf`, which is the same derivation `createApi` used
// to mount it, so a declaration that stopped generating a route fails here as
// a 404 rather than passing quietly.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { createApi } from '../../apps/api/app.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api surface operations: DATABASE_URL is unset, so nothing below ran.');
}

const BUSINESS_KEY = 'alpha';

async function refusalOf(
  response: Response,
): Promise<{ refused: boolean; code: string; names: readonly string[] }> {
  return (await response.json()) as { refused: boolean; code: string; names: readonly string[] };
}

describe.skipIf(serverUrl === undefined)('the new operations over HTTP', () => {
  let db: FreshDatabase;
  let alpha: string;
  let mia: Member;
  let noah: Member;
  let api: ReturnType<typeof createApi>;
  let taskId: string;
  let taskRevision: number;

  /**
   * The subject is carried in the header and verified by the injected
   * verifier, exactly as GoTrue's is: what is substituted is the signature
   * check, never who the caller turns out to be, which login resolution
   * decides inside the serving transaction like always.
   */
  const post = async (name: CommandName, body: unknown, who: Member = mia) =>
    await api.fetch(
      new Request(`http://api.test/api/b/${BUSINESS_KEY}${pathOf(name)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${who.presented.subject}`,
        },
        body: JSON.stringify(body),
      }),
    );

  const countFieldDefs = async () =>
    await db.app.withBusiness(alpha, async (tx) => {
      const rows = await tx.query<{ readonly n: string }>(
        'select count(*)::text as n from field_defs where business_id = $1',
        [tx.businessId],
      );
      return Number(rows[0]?.n ?? '0');
    });

  /** The subject and outcome of the most recent audit row for one command. */
  const lastAudit = async (command: string) =>
    await db.app.withBusiness(alpha, async (tx) => {
      const rows = await tx.query<{
        readonly outcome: string;
        readonly refusal_code: string | null;
        readonly subject_record_id: string | null;
      }>(
        `select outcome, refusal_code, subject_record_id
           from audit_events
          where business_id = $1 and command = $2
          order by seq desc
          limit 1`,
        [tx.businessId, command],
      );
      return rows[0];
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l3api' });
    alpha = await insertBusiness(db.app, BUSINESS_KEY);
    await installSpine(db.app, alpha);
    await db.app.withBusiness(alpha, async (tx) => {
      await installBusinessSettings(tx);
    });
    mia = await enrol(db.app, alpha, 'mia');
    noah = await enrol(db.app, alpha, 'noah');
    await db.app.withBusiness(alpha, async (tx) => {
      for (const action of ['read', 'write', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, mia, action);
      }
      // `preset.plan` takes `manage` on the family it plans, not a blanket
      // `manage` on `preset`: L2's planner checks the family of the request's
      // `recordTypeKey` and the surface now asks the same question. These
      // cases plan the `task` family, so that is the grant they need.
      await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'task');
      await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'settings');
    });

    api = createApi({
      database: db.app,
      // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
      verify: async (request) => {
        const header = request.header('authorization') ?? '';
        const subject = header.replace(/^Bearer /u, '');
        return subject === '' ? undefined : { provider: 'supabase', subject };
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
      resolveBusiness: async (key) => (key === BUSINESS_KEY ? alpha : undefined),
      executeCommand,
      executeRead: async (database, businessId, presented, request) =>
        await executeRead(
          database,
          businessId,
          presented,
          request as unknown as Parameters<typeof executeRead>[3],
        ),
    });

    const created = await post('task.create', {
      operationId: `create-${randomUUID()}`,
      fields: { title: 'A task over HTTP' },
    });
    const body = (await created.json()) as { recordId: string; revision: number };
    taskId = body.recordId;
    taskRevision = body.revision;
  }, 60_000);

  afterAll(async () => await db?.drop());

  describe('task.comment', () => {
    it('writes a comment and answers 200', async () => {
      const response = await post('task.comment', {
        operationId: `comment-${randomUUID()}`,
        recordId: taskId,
        expectedRevision: taskRevision,
        body: 'Over the wire',
        audience: 'internal',
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { detail: { commentId: string } }).toMatchObject({
        detail: { commentId: expect.any(String) },
      });
    });

    it('refuses a caller with no comment grant, 403 SCOPE_NOT_GRANTED', async () => {
      const response = await post(
        'task.comment',
        {
          operationId: `comment-${randomUUID()}`,
          recordId: taskId,
          expectedRevision: taskRevision,
          body: 'Not mine',
          audience: 'internal',
        },
        noah,
      );
      expect(response.status).toBe(403);
      expect(await refusalOf(response)).toMatchObject({
        refused: true,
        code: 'SCOPE_NOT_GRANTED',
      });
    });
  });

  describe('preset.plan', () => {
    it('answers the plan, 200', async () => {
      const response = await post('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [
          { key: 'campaign_code', label: 'Campaign code', valueType: 'text', writeMode: 'generic' },
        ],
      });
      expect(response.status).toBe(200);
      expect((await response.json()) as { plan: { presetKey: string } }).toMatchObject({
        ok: true,
        plan: { presetKey: 'marketing' },
      });
    });

    it('refuses an unclassified field 422 PRESET_FIELD_UNCLASSIFIED, naming it', async () => {
      const response = await post('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [{ key: 'undecided', label: 'Undecided', valueType: 'text' }],
      });
      expect(response.status).toBe(422);
      const refusal = await refusalOf(response);
      expect(refusal.code).toBe('PRESET_FIELD_UNCLASSIFIED');
      expect(refusal.names).toContain('undecided');
    });

    // The code L2's planner gained and this lane registered. Over HTTP it is a
    // 422 like the other bad-preset refusal, and the claim that matters is the
    // second one: a plan is a dry run, so a refused plan writes nothing at all.
    it('refuses one new key named twice 422 PRESET_FIELD_DUPLICATE, writing no field_defs row', async () => {
      const before = await countFieldDefs();
      const response = await post('preset.plan', {
        recordTypeKey: 'task',
        presetKey: 'marketing',
        fields: [
          { key: 'twice_over', label: 'Once', valueType: 'text', writeMode: 'generic' },
          { key: 'twice_over', label: 'Again', valueType: 'text', writeMode: 'generic' },
        ],
      });
      expect(response.status).toBe(422);
      const refusal = await refusalOf(response);
      expect(refusal.code).toBe('PRESET_FIELD_DUPLICATE');
      expect(refusal.names).toContain('twice_over');
      expect(await countFieldDefs()).toBe(before);
    });
  });

  describe('the settings operations', () => {
    it('sets the four-eyes band, 200, and refuses a value of the wrong type 422', async () => {
      const set = await post('settings.set_four_eyes_threshold', {
        operationId: `four-${randomUUID()}`,
        value: 900,
      });
      expect(set.status).toBe(200);

      const wrong = await post('settings.set_four_eyes_threshold', {
        operationId: `four-${randomUUID()}`,
        value: 'nine hundred',
      });
      expect(wrong.status).toBe(422);
      expect((await refusalOf(wrong)).code).toBe('FIELD_VALUE_INVALID');
    });

    it('sets client sign-off, 200, and refuses a caller without authority 403', async () => {
      const set = await post('settings.set_client_sign_off', {
        operationId: `sign-${randomUUID()}`,
        value: true,
      });
      expect(set.status).toBe(200);

      const denied = await post(
        'settings.set_client_sign_off',
        { operationId: `sign-${randomUUID()}`, value: false },
        noah,
      );
      expect(denied.status).toBe(403);
      expect((await refusalOf(denied)).code).toBe('SCOPE_NOT_GRANTED');
    });
  });

  // `task.read` takes the key the address carries, and the audit column it
  // writes into is a uuid. Writing the presented name there made the whole
  // read answer 503 with `invalid input syntax for type uuid: "T-67"` in the
  // API log -- a refusal the caller could do nothing about, on the ordinary
  // path of reading a task by the name the address gives it.
  describe('task.read by the key the address carries', () => {
    it('answers 200, and the audit row carries the task uuid rather than the key', async () => {
      const byId = await post('task.read', { recordId: taskId });
      expect(byId.status).toBe(200);
      const { task } = (await byId.json()) as { task: { id: string; key: string } };
      expect(task.id).toBe(taskId);

      const byKey = await post('task.read', { recordId: task.key });
      expect(byKey.status).toBe(200);
      expect(((await byKey.json()) as { task: { id: string } }).task.id).toBe(taskId);

      const audited = await lastAudit('task.read');
      expect(audited?.outcome).toBe('applied');
      expect(audited?.subject_record_id).toBe(taskId);
    });

    it('refuses an unknown key NOT_FOUND and audits it with a null subject', async () => {
      const response = await post('task.read', { recordId: 'T-nosuchtask' });
      expect(response.status).toBe(404);
      expect((await refusalOf(response)).code).toBe('NOT_FOUND');

      const audited = await lastAudit('task.read');
      expect(audited?.outcome).toBe('refused');
      expect(audited?.refusal_code).toBe('NOT_FOUND');
      expect(audited?.subject_record_id).toBeNull();
    });
  });
});
