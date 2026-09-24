// SPDX-License-Identifier: AGPL-3.0-only
//
// I10 in flight: a read admitted and still open in its transaction while
// `grant.revoke` commits, then the next call (ledger I10; transaction contract
// T5 and "An admitted in-flight read may finish, but its late completion
// cannot restore an authorised view after denial").
//
// `controls-revoke.test.ts` covers the same route before and after, strictly in
// sequence. Here the reader's read is stopped at a named point, right after
// `effectiveGrants` admitted it and before it reads the record, with its
// transaction open on its own backend. The revocation is the owning route,
// called over HTTP by ada, a business-wide grant manager, on the ordinary app
// instance; it commits while the read is held. Only then is the read let go.
//
// The hold is a promise the test resolves, not a sleep: the read cannot pass
// the point until `release()` runs, and the test cannot revoke until the read
// has reported that it reached the point. `pg_stat_activity` shows the held
// backend as `idle in transaction` on both sides of the revocation, and the
// audit chain puts the read's row after the revocation's, which is only
// possible if the read's transaction was still open when the revoke committed.
//
// The R4 party is `enrolExternal`'s, with a share issued by `shareRecord`, the
// owning setup function; no fixture row stands in for the grant.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type AgentExecutor, type ReadExecutor } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { shareRecord } from '../../packages/core-records/src/authority/shares.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import {
  ACCEPTANCE_SECRET,
  bearer,
  call,
  createWorld,
  enrolExternal,
  personPath,
  serverUrl,
  type Answer,
  type Caller,
  type World,
} from './world.ts';

const TITLE = 'I10 in flight: renewal terms under review';
const CLIENT_NOTE = 'I10 in flight: your draft is ready to read.';

/** The admission query: `effectiveGrants` in `authority/grants.ts`. */
const ADMISSION = /\bfrom effective e\b/u;

/** One armed stop at the admission point, for the next read that is admitted. */
interface Hold {
  /** Resolves with the held read's backend pid once it is admitted and stopped. */
  readonly admitted: Promise<number>;
  release(): void;
}

interface Holder {
  arm(): Hold;
}

/**
 * The application's database, with a stop after admission.
 *
 * Every statement goes through the real wrapper and the real transaction; the
 * only thing added is that, while a hold is armed, the first admission query
 * that returns a grant reports its backend and waits for `release()` before
 * the read carries on with what it was admitted to do.
 */
function holding(inner: Database): Database & Holder {
  let armed: { reached: (pid: number) => void; released: Promise<void> } | undefined;
  const wrap = (tx: TenantQuery): TenantQuery => ({
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
      const rows = await tx.query<Row>(text, parameters);
      const stop = armed;
      if (stop !== undefined && ADMISSION.test(text) && rows.length > 0) {
        armed = undefined;
        const [backend] = await tx.query<{ readonly pid: number }>(
          'select pg_backend_pid() as pid',
        );
        stop.reached(Number(backend?.pid));
        await stop.released;
      }
      return rows;
    },
  });
  return {
    log: inner.log,
    close: async () => await inner.close(),
    withBusiness: async (businessId, run) =>
      await inner.withBusiness(businessId, async (tx) => await run(wrap(tx))),
    arm() {
      let reached!: (pid: number) => void;
      let release!: () => void;
      const admitted = new Promise<number>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed = { reached, released };
      return { admitted, release };
    },
  };
}

/** One person-prefix call on the given app instance. */
const as = async (
  api: ReturnType<typeof createApi>,
  who: Caller,
  name: CommandName,
  body: Record<string, unknown>,
): Promise<Answer> => await call(api, personPath('alpha', pathOf(name)), body, bearer(who.token));

describe.skipIf(serverUrl === undefined)('I10: a read admitted during revocation', () => {
  let world: World;
  let ext: Caller;
  let reader: ReturnType<typeof holding>;
  let readerApi: ReturnType<typeof createApi>;

  const share = async (recordId: string, with_: Caller): Promise<string> => {
    const issued = await world.db.app.withBusiness(world.alpha, (tx) =>
      shareRecord(
        tx,
        { personId: world.ada.personId as string, actorId: world.ada.actorId as string },
        { collection: 'task', recordId, personId: with_.personId as string },
      ),
    );
    if (!issued.ok) throw new Error(`shareRecord refused ${issued.refusal.code}`);
    return issued.value;
  };

  const newTask = async (): Promise<string> => {
    const made = await as(world.api, world.ada, 'task.create', {
      operationId: randomUUID(),
      fields: { title: TITLE },
    });
    expect(made.code).toBe('ok');
    const recordId = String(made.body['recordId']);
    const read = await as(world.api, world.ada, 'task.read', { recordId });
    const written = await as(world.api, world.ada, 'task.comment', {
      operationId: randomUUID(),
      recordId,
      expectedRevision: Number((read.body['task'] as Record<string, unknown>)['revision']),
      body: CLIENT_NOTE,
      audience: 'client',
      commentType: 'client',
    });
    expect(written.code).toBe('ok');
    return recordId;
  };

  const backendState = async (pid: number): Promise<string | undefined> => {
    const rows = await world.db.admin.execute<{ readonly state: string }>(
      'select state from pg_stat_activity where pid = $1',
      [pid],
    );
    return rows[0]?.state;
  };

  const auditSeq = async (command: string, subject: string): Promise<number> => {
    const rows = await world.db.admin.execute<{ readonly seq: string }>(
      `select max(seq)::text as seq from public.audit_events
        where business_id = $1 and command = $2 and outcome = 'applied'
          and subject_record_id = $3`,
      [world.alpha, command, subject],
    );
    return Number(rows[0]?.seq ?? Number.NaN);
  };

  /**
   * Start a read, hold it at admission, revoke over HTTP, let it go.
   *
   * Answers the held read's answer, and the revocation's.
   */
  const readAcrossRevocation = async (
    who: Caller,
    recordId: string,
    grantId: string,
  ): Promise<{ admitted: Answer; revoked: Answer }> => {
    const hold = reader.arm();
    const reading = as(readerApi, who, 'task.read', { recordId });
    const pid = await hold.admitted;
    expect(await backendState(pid)).toBe('idle in transaction');

    const revoked = await as(world.api, world.ada, 'grant.revoke', {
      operationId: randomUUID(),
      grantId,
    });
    expect(revoked.status).toBe(200);
    const committed = await world.db.admin.execute<{ readonly revoked: boolean }>(
      'select revoked_at is not null as revoked from public.grants where id = $1',
      [grantId],
    );
    expect(committed).toEqual([{ revoked: true }]);
    // The revocation is committed and visible, and the read is still open.
    expect(await backendState(pid)).toBe('idle in transaction');

    hold.release();
    const admitted = await reading;
    // The read's audit row committed after the revocation's: its transaction
    // was open across the revoke's commit, not finished before it.
    expect(await auditSeq('task.read', recordId)).toBeGreaterThan(
      await auditSeq('grant.revoke', grantId),
    );
    return { admitted, revoked };
  };

  beforeAll(async () => {
    world = await createWorld('i10_inflight');
    ext = await enrolExternal(world);
    // A second instance over the same database for the reader, so the hold is
    // on the reader's connections only and the revocation runs on the
    // ordinary app, the way two callers reach one server.
    reader = holding(connect(world.db.appUrl, { source: 'runtime' }));
    readerApi = createApi({
      database: reader,
      verify: createSupabaseVerifier({ secret: ACCEPTANCE_SECRET }),
      resolveBusiness: async (key: string) => (key === 'alpha' ? world.alpha : undefined),
      executeCommand,
      executeRead: executeRead as unknown as ReadExecutor,
      executeAgentCommand: executeAgentCommand as unknown as AgentExecutor,
    });
  }, 120_000);

  afterAll(async () => {
    await reader?.close();
    await world?.close();
  });

  it('R4: the admitted shared read finishes with its content; the next call is refused', async () => {
    const recordId = await newTask();
    const grantId = await share(recordId, ext);

    const { admitted, revoked } = await readAcrossRevocation(ext, recordId, grantId);
    expect(revoked.body['command']).toBe('grant.revoke');

    expect(admitted.status).toBe(200);
    expect(admitted.body['sharedTask']).toStrictEqual({
      id: recordId,
      fields: {},
      comments: [expect.objectContaining({ audience: 'client', body: CLIENT_NOTE })],
    });

    // The next call, on the same instance that served the admitted read, is
    // re-evaluated: with no live share the login no longer resolves.
    const next = await as(readerApi, ext, 'task.read', { recordId });
    expect(next.status).toBe(403);
    expect(next.code).toBe('AUTH_NO_MEMBERSHIP');
    const text = JSON.stringify(next.body);
    for (const content of [recordId, CLIENT_NOTE, TITLE]) expect(text).not.toContain(content);
  });

  it('a member on a record grant: the admitted read finishes; the next is SCOPE_NOT_GRANTED', async () => {
    const recordId = await newTask();
    // noah is a member with no grants at all; this record grant is his only
    // authority, so its revocation is the whole difference between the reads.
    const refusedFirst = await as(readerApi, world.noah, 'task.read', { recordId });
    expect(refusedFirst.code).toBe('SCOPE_NOT_GRANTED');
    const grantId = await share(recordId, world.noah);

    const { admitted } = await readAcrossRevocation(world.noah, recordId, grantId);
    expect(admitted.status).toBe(200);
    const task = admitted.body['task'] as Record<string, unknown>;
    expect(task['id']).toBe(recordId);
    expect(JSON.stringify(admitted.body)).toContain(TITLE);

    const next = await as(readerApi, world.noah, 'task.read', { recordId });
    expect(next.status).toBe(403);
    expect(next.code).toBe('SCOPE_NOT_GRANTED');
    const text = JSON.stringify(next.body);
    for (const content of [recordId, CLIENT_NOTE, TITLE]) expect(text).not.toContain(content);
  });
});
