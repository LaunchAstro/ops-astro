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
import { cliWorld, idOf, revisionIn, type Caller, type CliWorld } from './api-3-world.ts';
import { VERB_TABLE } from '../../apps/cli/verbs.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/index.ts';
import type { Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const json = (out: string): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>;

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
    const second = await create(cli, 'tracked two', '--parent', parent);
    const linked = await cli.run(
      'task',
      'link',
      second,
      '--blocked-by',
      first,
      '--revision',
      String(await w.revisionOf(second)),
    );
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
    const resolved = await cli.run(
      'task',
      'resolve',
      first,
      '--revision',
      revisionIn(updated),
      '--answer',
      'done',
      '--gist',
      'done',
    );
    for (const answer of [linked, commented, updated, resolved])
      expect(answer.exit, answer.out).toBe(0);
    const audit = await w.audit();
    for (const command of [
      'task.create',
      'task.set_blocking',
      'task.comment',
      'task.update',
      'task.resolve',
    ]) {
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

  it('API-3 owner check flow: a task with two subtasks, one blocked by the other, a comment, one resolved', async () => {
    // The staging recording waits on SL01 U01; this is the same flow, locally.
    const parent = await create(cli, `owner check ${randomUUID().slice(0, 4)}`);
    const one = await create(cli, 'first subtask', '--parent', parent);
    const two = await create(cli, 'second subtask', '--parent', parent);
    expect(
      (
        await cli.run(
          'task',
          'link',
          two,
          '--blocked-by',
          one,
          '--revision',
          String(await w.revisionOf(two)),
        )
      ).exit,
    ).toBe(0);
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
    expect(
      (
        await cli.run(
          'task',
          'resolve',
          one,
          '--revision',
          String(await w.revisionOf(one)),
          '--answer',
          'finished',
          '--gist',
          'finished',
        )
      ).exit,
    ).toBe(0);
    const app = await w.read(lead, { read: 'task.read', recordId: one });
    expect(JSON.stringify(app)).toContain('starting on it');
    const got = json((await cli.run('task', 'get', two, '--detail', 'full', '--json')).out);
    expect(JSON.stringify(got)).toContain(one);
  });
});
