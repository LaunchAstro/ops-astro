// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines, max-lines-per-function -- calls in order; one suite per ticket: one case per checklist line on one composed API */
//
// API-3, the agent CLI: one case named after each supporting-checklist line
// and acceptance criterion this slice can prove locally. Every call runs the
// verb CLI (`apps/cli/verbs.ts`) over the composed API in process and is
// checked against the database, the audit log or the envelope's own answer.
// `API-3 isolation` is its own suite (`api-3-isolation.test.ts`), the budgets
// theirs (`api-3-budget.test.ts`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { countTokens } from '../support/token-count.ts';
import { cliWorld, idOf, type Caller, type CliWorld } from './api-3-world.ts';
import { createVerbCli, VERB_TABLE } from '../../apps/cli/verbs.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { COMMAND_SURFACE, DELEGATION_HEADER, PREFIX } from '../../packages/core-wire/src/index.ts';
import { shareWithClient, type Member } from '../commands/fixture.ts';
import { tokenFor } from '../api/fixture.ts';
import { connect, lockAccess } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();

const json = (out: string): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>;

/** The ids of a page, in order. */
const ids = (answer: { readonly body: Record<string, unknown> }): string[] =>
  ((answer.body['page'] ?? []) as { readonly id: string }[]).map((item) => item.id);

async function create(caller: Caller, title: string, ...extra: string[]) {
  const answer = await caller.run('task', 'create', '--title', title, ...extra);
  expect(answer.exit, answer.out).toBe(0);
  return idOf(answer);
}

describe.skipIf(serverUrl === undefined)('API-3 the agent CLI', () => {
  let w: CliWorld;
  let lead: Member;
  let cli: Caller;

  const rev = async (id: string): Promise<string> => String(await w.revisionOf(id));

  /** One request on the person prefix, or the agent prefix under `delegation`. */
  async function post(
    member: Member | string,
    path: string,
    body: Readonly<Record<string, unknown>>,
    delegation?: string,
  ): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const subject = typeof member === 'string' ? member : member.presented.subject;
    const prefix = delegation === undefined ? PREFIX.person : PREFIX.agent;
    const response = await w.api.fetch(
      new Request(`http://api.test${prefix}${w.key}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await tokenFor(subject)}`,
          ...(delegation === undefined ? {} : { [DELEGATION_HEADER]: delegation }),
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** Rank `id` on its board, between `afterId` and `beforeId`, as the board's drag does. */
  async function rank(id: string, afterId: string | null, beforeId: string | null) {
    const ranked = await w.as(lead, {
      command: 'task.rank',
      operationId: randomUUID(),
      recordId: id,
      expectedRevision: await w.revisionOf(id),
      afterId,
      beforeId,
    });
    expect(ranked, JSON.stringify(ranked)).not.toHaveProperty('refused');
  }

  /** Waits until some statement on this database waits on a lock; throws past the deadline. */
  async function blockedOnLock(deadline: number): Promise<void> {
    const rows = await w.db.admin.execute<{ readonly pid: number }>(
      `select pid from pg_stat_activity
        where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
        limit 1`,
    );
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error('the update never waited on the task lock');
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    await blockedOnLock(deadline);
  }

  beforeAll(async () => {
    w = await cliWorld('api3', 'api3');
    lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    cli = await w.person(lead);
  }, 180_000);

  afterAll(async () => await w?.drop());

  it('API-3 each verb dispatches to the owning command; the CLI holds no rule of its own', async () => {
    const owned = new Set(COMMAND_SURFACE.map((row) => row.name as string));
    for (const row of VERB_TABLE) expect(owned, row.verb).toContain(row.command);
    // The refusal is the envelope's, byte for byte in its code: a stale
    // revision is refused by the command, never checked by the CLI first.
    const id = await create(cli, 'owned');
    const stale = await cli.run('task', 'update', id, '--revision', '99', '--title', 'x');
    expect(stale.exit).toBe(1);
    expect(stale.out).toContain('VERSION_STALE');
    const audit = await w.audit();
    expect(
      audit.some((line) => line.command === 'task.update' && line.code === 'VERSION_STALE'),
    ).toBe(true);
  });

  it('API-3 every read accepts brief, standard and full, and full returns the whole thread and history', async () => {
    const id = await create(cli, 'levels');
    for (let at = 0; at < 12; at += 1) {
      expect(
        (
          await cli.run(
            'task',
            'comment',
            id,
            '--revision',
            await rev(id),
            '--text',
            `note ${String(at)}`,
          )
        ).exit,
      ).toBe(0);
    }
    const brief = json((await cli.run('task', 'get', id, '--detail', 'brief', '--json')).out);
    expect(Object.keys(brief).toSorted()).toStrictEqual(['id', 'state', 'title']);
    const standard = json((await cli.run('task', 'get', id, '--json')).out);
    expect(standard['title']).toBe('levels');
    expect(standard).not.toHaveProperty('history');
    expect((standard['comments'] as unknown[]).length).toBeLessThan(12);
    const full = json((await cli.run('task', 'get', id, '--detail', 'full', '--json')).out);
    expect((full['comments'] as unknown[]).length).toBe(12);
    expect((full['history'] as unknown[]).length).toBeGreaterThan(0);
    const refused = await cli.run('task', 'get', id, '--detail', 'everything');
    expect(refused.exit).toBe(2);
  });

  it('API-3 field selection returns only the fields named', async () => {
    const id = await create(cli, 'fields');
    const answer = json((await cli.run('task', 'get', id, '--fields', 'id,title', '--json')).out);
    expect(answer).toStrictEqual({ id, title: 'fields' });
    const listed = json(
      (await cli.run('task', 'list', '--detail', 'brief', '--fields', 'id', '--json')).out,
    );
    for (const item of listed['items'] as Record<string, unknown>[]) {
      expect(Object.keys(item)).toStrictEqual(['id']);
    }
  });

  it('API-3 pagination returns stable pages with a next token', async () => {
    const board = await create(cli, 'paging board');
    const made = new Set<string>();
    for (let at = 0; at < 25; at += 1) {
      made.add(await create(cli, `paged ${String(at)}`, '--board', board));
    }
    const seen: string[] = [];
    let next: unknown;
    let pages = 0;
    do {
      const page = json(
        (
          await cli.run(
            'task',
            'list',
            '--board',
            board,
            '--limit',
            '10',
            '--detail',
            'brief',
            '--json',
            ...(typeof next === 'string' ? ['--page', next] : []),
          )
        ).out,
      );
      if (pages === 0) await create(cli, 'added between pages', '--board', board);
      seen.push(...(page['items'] as { id: string }[]).map((item) => item.id));
      next = page['next'];
      pages += 1;
    } while (typeof next === 'string' && pages < 5);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of made) expect(seen).toContain(id);
  });

  it('API-3 pagination: a task moved behind the page token between pages is never shown twice', async () => {
    const board = await create(cli, 'reorder board');
    const a = await create(cli, 'reorder A', '--board', board);
    const b = await create(cli, 'reorder B', '--board', board);
    const c = await create(cli, 'reorder C', '--board', board);
    const first = await post(lead, '/task/board', { board, detail: 'brief', limit: 2 });
    expect(ids(first)).toStrictEqual([a, b]);
    await rank(a, c, null);
    const second = await post(lead, '/task/board', {
      board,
      detail: 'brief',
      limit: 2,
      page: first.body['next'],
    });
    expect(ids(second)).not.toContain(a);
    // The order the token was read in has changed: list again from the start.
    expect(second.status).toBe(422);
    expect(second.body['names']).toStrictEqual(['page']);
  });

  it('API-3 pagination: a task moved ahead of the page token between pages is never left out', async () => {
    const board = await create(cli, 'reorder ahead board');
    const a = await create(cli, 'ahead A', '--board', board);
    const b = await create(cli, 'ahead B', '--board', board);
    const c = await create(cli, 'ahead C', '--board', board);
    const first = await post(lead, '/task/board', { board, detail: 'brief', limit: 2 });
    expect(ids(first)).toStrictEqual([a, b]);
    await rank(c, null, a);
    const second = await post(lead, '/task/board', {
      board,
      detail: 'brief',
      limit: 2,
      page: first.body['next'],
    });
    // C was never shown and now sits before the token: an answer would leave it out.
    expect(second.status).toBe(422);
    expect(second.body['names']).toStrictEqual(['page']);
  });

  it('API-3 a write whose answer was lost is replayed by its operation id and made once', async () => {
    let lose = true;
    const transport: Transport = async (path, body, bearer) => {
      const response = await w.api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
          body,
        }),
      );
      if (!lose) return response;
      // The write committed; only its answer is lost on the way back.
      lose = false;
      throw new Error('the connection dropped after the request was sent');
    };
    const verbs = createVerbCli({
      transport,
      businessKey: w.key,
      credential: await tokenFor(lead.presented.subject),
      entry: 'person',
    });
    const title = `retry-canary-${randomUUID().slice(0, 8)}`;
    const lost = await verbs.run(['task', 'create', '--title', title]);
    expect(lost.exit).toBe(3);
    const operationId = /operationId ([0-9a-f-]{36})/u.exec(lost.out)?.[1];
    expect(operationId, lost.out).toBeDefined();
    const again = await verbs.run([
      'task',
      'create',
      '--title',
      title,
      '--operation',
      operationId ?? '',
    ]);
    expect(again.exit, again.out).toBe(0);
    const made = await w.db.admin.execute<{ readonly id: string }>(
      `select id::text as id from public.records where business_id = $1 and data->>'title' = $2`,
      [w.business, title],
    );
    expect(made).toHaveLength(1);
    expect(idOf(again)).toBe(made[0]?.id);
  });

  it('API-3 an external party reads its shared task at each level, and brief carries no thread', async () => {
    const id = await create(cli, 'shared levels', '--description', 'shared words');
    for (let at = 0; at < 12; at += 1) {
      const said = await cli.run(
        'task',
        'comment',
        id,
        '--revision',
        await rev(id),
        '--text',
        `client note ${String(at)}`,
        '--audience',
        'client',
      );
      expect(said.exit, said.out).toBe(0);
    }
    await w.grant(lead, 'share');
    const client = await shareWithClient(w.db.app, w.business, lead, id);
    const view = async (detail: string): Promise<Record<string, unknown>> => {
      const answer = await post(client, '/task/read', { recordId: id, detail });
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect(answer.body['detail']).toBe(detail);
      return answer.body['view'] as Record<string, unknown>;
    };
    const brief = await view('brief');
    expect(Object.keys(brief).toSorted()).toStrictEqual(['id', 'state', 'title']);
    expect(brief['title']).toBe('shared levels');
    const standard = await view('standard');
    expect(standard['comments']).toHaveLength(5);
    expect(standard['commentCount']).toBe(12);
    expect(JSON.stringify(standard['comments'])).toContain('client note 11');
    expect(JSON.stringify(standard['comments'])).not.toContain('client note 6');
    const full = await view('full');
    expect(full['comments']).toHaveLength(12);
    const printed = await (
      await w.person(client)
    ).run('task', 'get', id, '--detail', 'brief', '--json');
    expect(printed.exit, printed.out).toBe(0);
    expect(Object.keys(json(printed.out)).toSorted()).toStrictEqual(['id', 'state', 'title']);
  });

  it('API-3 a detail level the read does not know is refused on the agent prefix as on the person prefix', async () => {
    const picked = await w.pickUp(await w.decider('level-delegator'), 'level task');
    const asAgent = await post(
      w.agentSubject(),
      '/task/read',
      { operationId: randomUUID(), recordId: picked.taskId, detail: 'everything' },
      picked.credential,
    );
    const asPerson = await post(lead, '/task/read', {
      recordId: picked.taskId,
      detail: 'everything',
    });
    for (const answer of [asAgent, asPerson]) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
      expect(answer.body['names']).toStrictEqual(['detail']);
    }
  });

  it('API-3 a task update whose write grant is revoked while it waits for the task is refused and changes nothing', async () => {
    const writer = await w.member('revoked-writer', ['read', 'write']);
    const id = await create(cli, 'revoke while waiting');
    const revision = await rev(id);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    // Another transaction holds the task, unchanged, on a connection of its own
    // (the world's pool, which the API uses, has one).
    const side = connect(w.db.appUrl, { max: 1 });
    const holder = side.withBusiness(w.business, async (tx) => {
      await tx.query(
        'select id from public.records where business_id = $1 and id = $2 for update',
        [w.business, id],
      );
      holding?.();
      await released;
    });
    try {
      await held;
      const writes = await w.person(writer);
      const update = writes.run(
        'task',
        'update',
        id,
        '--revision',
        revision,
        '--title',
        'after-revoke',
      );
      await blockedOnLock(Date.now() + 10_000);
      // The writer's only write grant is revoked, and the revocation commits, while it waits.
      const revoked = await w.db.admin.execute(
        `update public.grants set revoked_at = now()
          where business_id = $1 and subject_kind = 'person' and subject_id = $2
            and collection = 'task' and action = 'write' and revoked_at is null
          returning id`,
        [w.business, writer.personId],
      );
      expect(revoked).toHaveLength(1);
      release?.();
      await holder;
      const answer = await update;
      expect(answer.exit, answer.out).toBe(1);
      expect(answer.out).toContain('task:write');
      const [row] = await w.db.admin.execute<{ readonly title: string }>(
        `select data->>'title' as title from public.records where business_id = $1 and id = $2`,
        [w.business, id],
      );
      expect(row?.title).toBe('revoke while waiting');
      const audit = await w.audit();
      const last = audit.filter((line) => line.command === 'task.update' && line.subject === id);
      expect(last.map((line) => line.outcome)).not.toContain('applied');
    } finally {
      release?.();
      await holder.catch(() => null);
      await side.close();
    }
  });

  /**
   * A write held at the business's audit chain (`audit_events_chain`'s lock,
   * taken by another transaction on a connection of its own) while its
   * writer's only write grant is revoked: the revocation waits for the write
   * to commit, and the write commits under the grant it was judged on. The
   * revocation takes the access lock first, as `revokeGrantRow` does.
   */
  async function revokeAtAuditChain<T>(
    name: string,
    write: (caller: Caller) => Promise<T>,
  ): Promise<T> {
    const writer = await w.member(name, ['read', 'write']);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const side = connect(w.db.appUrl, { max: 1 });
    const revoker = connect(w.db.appUrl, { max: 1 });
    const holder = side.withBusiness(w.business, async (tx) => {
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [w.business]);
      holding?.();
      await released;
    });
    try {
      await held;
      const writing = write(await w.person(writer));
      await blockedOnLock(Date.now() + 10_000);
      // Revoked as every revocation is: the access lock first (`lockAccess`), on a third connection.
      let revoked = false;
      const revoking = revoker
        .withBusiness(w.business, async (tx) => {
          await lockAccess(tx);
          return await tx.query(
            `update public.grants set revoked_at = now()
              where business_id = $1 and subject_kind = 'person' and subject_id = $2
                and collection = 'task' and action = 'write' and revoked_at is null
              returning id`,
            [w.business, writer.personId],
          );
        })
        .then((rows) => {
          revoked = true;
          return rows;
        });
      await lockWaiters(2, () => revoked, Date.now() + 10_000);
      expect(revoked, 'the revocation committed while the write waited').toBe(false);
      release?.();
      await holder;
      const answer = await writing;
      expect(await revoking).toHaveLength(1);
      return answer;
    } finally {
      release?.();
      await holder.catch(() => null);
      await side.close();
      await revoker.close();
    }
  }

  /** Waits until `n` statements on this database wait on a lock, or `done()`; throws past the deadline. */
  async function lockWaiters(n: number, done: () => boolean, deadline: number): Promise<void> {
    const [row] = await w.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
    );
    if (done() || Number(row?.n ?? 0) >= n) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${String(n)} lock waiters`);
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
    await lockWaiters(n, done, deadline);
  }

  it('API-3 a task update whose write grant is revoked while it waits for the audit chain commits before the revocation', async () => {
    const id = await create(cli, 'before-revoke');
    const revision = await rev(id);
    const answer = await revokeAtAuditChain('audit-wait-writer', (writes) =>
      writes.run('task', 'update', id, '--revision', revision, '--title', 'after-revoke'),
    );
    expect(answer.exit, answer.out).toBe(0);
    const [row] = await w.db.admin.execute<{ readonly title: string }>(
      `select data->>'title' as title from public.records where business_id = $1 and id = $2`,
      [w.business, id],
    );
    expect(row?.title).toBe('after-revoke');
  });

  it('API-3 a task create whose write grant is revoked while it waits for the audit chain commits before the revocation', async () => {
    const answer = await revokeAtAuditChain('audit-wait-creator', (writes) =>
      writes.run('task', 'create', '--title', 'made before the revoke'),
    );
    expect(answer.exit, answer.out).toBe(0);
  });

  it('API-3 a refusal reads in plain words with the missing key named, in one line', async () => {
    const reader = await w.person(await w.member('reader-only', ['read']));
    const answer = await reader.run('task', 'create', '--title', 'not mine to make');
    expect(answer.exit).toBe(1);
    expect(answer.out.trim().split('\n')).toHaveLength(1);
    expect(answer.out).toContain('task:write');
    expect(answer.out).not.toMatch(/[{}]/u);
  });

  it('API-3 the whole help, as an agent loads it, is under 1,500 tokens', async () => {
    const help = await cli.run('help');
    expect(help.exit).toBe(0);
    for (const row of VERB_TABLE) expect(help.out).toContain(row.verb);
    expect(countTokens(help.out)).toBeLessThan(1_500);
  });

  it('API-3 a person and an agent get the same results for the same grants', async () => {
    // LEANS-ON SL09 U18: until the agent credential lands, the agent's grants
    // are its pickup delegation's, narrowed to the picked task; the person is
    // given exactly read and comment on that task.
    const picked = await w.pickUp(await w.decider('delegator'), 'parity task');
    const agent = await w.agent(picked.credential);
    const same = await w.person(
      await w.member('same-grants', ['read', 'comment'], { kind: 'record', id: picked.taskId }),
    );
    const fromAgent = await agent.run('task', 'get', picked.taskId, '--detail', 'brief');
    const fromPerson = await same.run('task', 'get', picked.taskId, '--detail', 'brief');
    expect(fromAgent.exit).toBe(0);
    expect(fromAgent.out).toBe(fromPerson.out);
    const other = await create(cli, 'outside both');
    const agentOut = await agent.run('task', 'get', other);
    const personOut = await same.run('task', 'get', other);
    expect(agentOut.exit).toBe(1);
    expect(personOut.exit).toBe(1);
  });

  it('API-3 the command that causes each tracked action writes it in the same transaction and joins the audit chain', async () => {
    const parent = await create(cli, 'tracked parent');
    const first = await create(cli, 'tracked one', '--parent', parent);
    const commented = await cli.run(
      'task',
      'comment',
      first,
      '--revision',
      await rev(first),
      '--text',
      'tracked comment',
    );
    const updated = await cli.run(
      'task',
      'update',
      first,
      '--revision',
      String(await w.revisionOf(first)),
      '--title',
      'tracked one, renamed',
    );
    for (const answer of [commented, updated]) expect(answer.exit, answer.out).toBe(0);
    const audit = await w.audit();
    for (const command of ['task.create', 'task.comment', 'task.update']) {
      expect(
        audit.some((line) => line.command === command && line.outcome === 'applied'),
        command,
      ).toBe(true);
    }
    // The agent's own write names the agent as its actor.
    const picked = await w.pickUp(await w.decider('tracked-delegator'), 'tracked agent task');
    const agent = await w.agent(picked.credential);
    expect(
      (
        await agent.run(
          'task',
          'comment',
          picked.taskId,
          '--revision',
          await rev(picked.taskId),
          '--text',
          'agent note',
        )
      ).exit,
    ).toBe(0);
    const actors = await w.db.admin.execute<{ readonly actor: string }>(
      `select actor_id::text as actor from public.audit_events
        where business_id = $1 and command = 'task.comment' and subject_record_id = $2
          and outcome = 'applied'`,
      [w.business, picked.taskId],
    );
    expect(actors.map((row) => row.actor)).toContain(w.agentActorId);
    // One unbroken chain: every event's prev_hash is the event before it.
    const broken = await w.db.admin.execute<{ readonly broken: string }>(
      `select count(*)::text as broken from public.audit_events e
         join public.audit_events p on p.business_id = e.business_id and p.seq = e.seq - 1
        where e.business_id = $1 and e.prev_hash is distinct from p.hash`,
      [w.business],
    );
    expect(broken[0]?.broken).toBe('0');
  });

  it('API-3 each call is one HTTP round trip', async () => {
    const id = await create(cli, 'round trips');
    const verbs: string[][] = [
      ['task', 'get', id],
      ['task', 'list', '--detail', 'brief'],
      ['task', 'comment', id, '--revision', await rev(id), '--text', 'one trip'],
    ];
    for (const argv of verbs) {
      const before = cli.requests();
      await cli.run(...argv);
      expect(cli.requests() - before, argv.join(' ')).toBe(1);
    }
  });

  it('API-3 a refusal per permission key: task:read, task:write, task:comment', async () => {
    const target = await create(cli, 'keys');
    const none = await w.person(await w.member('holds-comment', ['comment']));
    const readOnly = await w.person(await w.member('holds-read', ['read']));
    const cases: [Caller, string[], string][] = [
      [none, ['task', 'get', target], 'task:read'],
      [readOnly, ['task', 'update', target, '--revision', '1', '--title', 'x'], 'task:write'],
      [readOnly, ['task', 'comment', target, '--revision', '1', '--text', 'x'], 'task:comment'],
    ];
    for (const [caller, argv, key] of cases) {
      const answer = await caller.run(...argv);
      expect(answer.exit, argv.join(' ')).toBe(1);
      expect(answer.out, argv.join(' ')).toContain(key);
    }
  });

  it('API-3 owner check flow: a task with two subtasks, one blocked by the other, a comment', async () => {
    // The staging recording waits on SL01 U01; this is the same flow, locally.
    const parent = await create(cli, `owner check ${randomUUID().slice(0, 4)}`);
    const one = await create(cli, 'first subtask', '--parent', parent);
    const two = await create(cli, 'second subtask', '--parent', parent);
    await w.blocks(one, two);
    expect(
      (
        await cli.run(
          'task',
          'comment',
          one,
          '--revision',
          await rev(one),
          '--text',
          'starting on it',
        )
      ).exit,
    ).toBe(0);
    const app = await w.read(lead, { read: 'task.read', recordId: one });
    expect(JSON.stringify(app)).toContain('starting on it');
    const got = json((await cli.run('task', 'get', two, '--detail', 'full', '--json')).out);
    expect(JSON.stringify(got)).toContain(one);
  });
});
