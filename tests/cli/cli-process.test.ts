// SPDX-License-Identifier: AGPL-3.0-only
//
// The command line as a process, against the API as a process (lane CLI-ENTRY).
//
// `mounted-cli.test.ts` drives the importable client from inside vitest. This
// suite does not import the client at all: it spawns `apps/api/server.ts` on a
// free port against a fresh database, then runs `apps/cli/main.ts` as its own
// OS process for every call, over real HTTP, and reads the database to check
// what each call changed. Identities come from the acceptance world
// (`tests/acceptance/world.ts`): bearers signed with the acceptance secret and
// verified by the production Supabase verifier inside the spawned server. The
// command line is handed a bearer exactly as it would be after `login`.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-records/src/commands/surface.ts';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

const PROPOSAL = {
  purpose: 'draft_the_reply',
  maximumMinor: 3_000,
  currency: 'AUD',
  payload: { instruction: 'draft a reply' },
  step: { kind: 'compose', payload: {} },
} as const;

function detailOf(run: Run): Record<string, unknown> {
  const detail = run.json?.['detail'];
  if (typeof detail !== 'object' || detail === null) {
    throw new Error(`no detail: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return detail as Record<string, unknown>;
}

function written(run: Run): { readonly recordId: string; readonly revision: number } {
  const body = run.json;
  if (run.code !== 0 || body === undefined || typeof body['recordId'] !== 'string') {
    throw new Error(`not a write answer: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return { recordId: body['recordId'], revision: Number(body['revision']) };
}

// eslint-disable-next-line max-lines-per-function -- one served API, the calls that share it
describe.skipIf(serverUrl === undefined)('the command line as a separate process', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;
  const tokens: string[] = [];

  /** The environment one command-line process gets: nothing from the shell. */
  const as = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
    ...extra,
  });

  async function stored(recordId: string) {
    const rows = await world.db.admin.execute<{
      readonly revision: string;
      readonly data: Readonly<Record<string, unknown>>;
    }>('select revision::text as revision, data from public.records where id = $1', [recordId]);
    const row = rows[0];
    if (row === undefined) throw new Error(`no record ${recordId}`);
    return { revision: Number(row.revision), data: row.data };
  }

  async function count(table: string): Promise<number> {
    const rows = await world.db.admin.execute<{ readonly n: string }>(
      `select count(*)::text as n from public.${table}`,
    );
    return Number(rows[0]?.n ?? '-1');
  }

  /** No output a process wrote may carry a bearer or a delegation credential. */
  function expectNoCredential(run: Run, ...more: readonly string[]): void {
    for (const secret of [...tokens, ...more]) {
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
    }
  }

  beforeAll(async () => {
    world = await createWorld('clip');
    tokens.push(world.ada.token, world.noah.token, world.agent.token);
    scratch = mkdtempSync(join(tmpdir(), 'cli-process-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it('--help lists every declared operation from the registry and sends nothing', async () => {
    const run = await runCli(['--help'], {});
    expect(run.code).toBe(0);
    for (const declaration of COMMAND_SURFACE) expect(run.stdout).toContain(declaration.name);
  });

  it('the package script runs the same entry: `pnpm cli person.list` answers from the API', async () => {
    const run = await runCli(['person.list'], as(world.ada.token), '', 'pnpm');
    expect(run.code, run.stderr).toBe(0);
    // One JSON value and nothing else, so `pnpm cli ... | jq` parses (CLI.md).
    expect(run.json, run.stdout).toBeDefined();
    expect(run.json?.['refused']).toBeUndefined();
    expect(run.stdout).toContain(String(world.mia.personId));
    expectNoCredential(run);
  }, 30_000);

  it('creates, assigns, starts, completes and reads a task, each call its own process', async () => {
    const title = `through the process ${randomUUID()}`;
    const made = written(
      await runCli(
        ['task.create', '--json', JSON.stringify({ fields: { title } })],
        as(world.ada.token),
      ),
    );
    expect((await stored(made.recordId)).revision).toBe(made.revision);

    const assignRun = await runCli(
      [
        'task.assign',
        '--json',
        JSON.stringify({
          recordId: made.recordId,
          expectedRevision: made.revision,
          fields: { assignee: world.mia.personId },
        }),
      ],
      as(world.ada.token),
    );
    expectNoCredential(assignRun);
    const assigned = written(assignRun);
    const afterAssign = await stored(made.recordId);
    expect(afterAssign.data['assignee']).toBe(world.mia.personId);
    expect(afterAssign.revision).toBe(assigned.revision);

    const bodyFile = join(scratch, 'start.json');
    writeFileSync(
      bodyFile,
      JSON.stringify({ recordId: made.recordId, expectedRevision: assigned.revision }),
    );
    const started = written(
      await runCli(['task.start', '--body-file', bodyFile], as(world.ada.token)),
    );
    const afterStart = await stored(made.recordId);
    expect(afterStart.revision).toBe(started.revision);
    expect(afterStart.data['state']).not.toBe(afterAssign.data['state']);

    const completed = written(
      await runCli(
        [
          'task.complete',
          `--json=${JSON.stringify({ recordId: made.recordId, expectedRevision: started.revision })}`,
        ],
        as(world.ada.token),
      ),
    );
    const afterComplete = await stored(made.recordId);
    expect(afterComplete.revision).toBe(completed.revision);
    expect(afterComplete.data['completed_at']).toStrictEqual(expect.any(String));

    const read = await runCli(
      ['task.read', '--json', JSON.stringify({ recordId: made.recordId })],
      as(world.ada.token),
    );
    expect(read.code).toBe(0);
    const task = read.json?.['task'] as Record<string, unknown>;
    expect(task['id']).toBe(made.recordId);
    expect(task['revision']).toBe(afterComplete.revision);
    expect(task['title']).toBe(title);
    expect((task['state'] as Record<string, unknown>)['machineCategory']).toBe('completed');
    expect((task['assignee'] as Record<string, unknown>)['personId']).toBe(world.mia.personId);
  }, 60_000);

  it('reads the board and the people list', async () => {
    const board = await runCli(
      ['task.board', '--json', JSON.stringify({ board: null })],
      as(world.ada.token),
    );
    expect(board.code, board.stdout).toBe(0);
    expect(board.json?.['refused']).toBeUndefined();

    const people = await runCli(['person.list'], as(world.ada.token));
    expect(people.code, people.stdout).toBe(0);
    expect(people.stdout).toContain(String(world.mia.personId));
  }, 30_000);

  it('a member with no grant is refused SCOPE_NOT_GRANTED, exits 1, and no record is written', async () => {
    const before = await count('records');
    const run = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title: 'not allowed' } })],
      as(world.noah.token),
    );
    expect(run.code).toBe(1);
    expect(run.json).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
    expect(Object.keys(run.json ?? {}).toSorted()).toStrictEqual([
      'code',
      'fixes',
      'names',
      'refused',
    ]);
    expect(await count('records')).toBe(before);
    expectNoCredential(run);
  }, 30_000);

  it('another business is refused exactly as the API refuses it', async () => {
    const run = await runCli(['person.list', '--business', 'bravo'], as(world.ada.token));
    expect(run.code).toBe(1);
    const direct = await fetch(`${(api as ServedApi).origin}/api/b/bravo/person/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${world.ada.token}` },
      body: JSON.stringify({ operationId: randomUUID() }),
    });
    expect(run.json).toStrictEqual(await direct.json());
    expect(run.json).toMatchObject({ refused: true, code: 'AUTH_NO_MEMBERSHIP' });
  }, 30_000);

  it('an unknown verb exits 2 without a request reaching the API', async () => {
    const before = await count('authentication_attempts');
    const run = await runCli(['task.teleport', '--json', '{}'], as(world.ada.token));
    expect(run.code).toBe(2);
    expect(run.json).toMatchObject({ code: 'COMMAND_UNKNOWN', names: ['task.teleport'] });
    expect(await count('authentication_attempts')).toBe(before);
  }, 30_000);

  it('a bad body or a missing bearer exits 2 and sends nothing', async () => {
    const before = await count('authentication_attempts');
    const bad = await runCli(['task.create', '--json', '[1]'], as(world.ada.token));
    expect(bad.code).toBe(2);
    const env: Record<string, string> = { ...as('') };
    delete env['OPS_ASTRO_TOKEN'];
    const bare = await runCli(['person.list'], env);
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain('no bearer');
    expect(await count('authentication_attempts')).toBe(before);
  }, 30_000);

  it('a transport failure exits 3', async () => {
    const run = await runCli(
      ['person.list'],
      as(world.ada.token, { OPS_ASTRO_API_URL: 'http://127.0.0.1:9' }),
    );
    expect(run.code).toBe(3);
    expectNoCredential(run);
  }, 30_000);

  // eslint-disable-next-line max-lines-per-function, max-statements -- one agent journey
  it('an agent queues, picks up, heartbeats and hands back through the command line', async () => {
    await world.db.admin.execute(
      'update public.budget_caps set limit_minor = 1000000000 where business_id = $1',
      [world.alpha],
    );
    const person = as(world.ada.token);
    const task = written(
      await runCli(
        ['task.create', '--json', JSON.stringify({ fields: { title: 'for the agent' } })],
        person,
      ),
    );
    const proposed = await runCli(
      [
        'task.propose',
        '--json',
        JSON.stringify({ recordId: task.recordId, expectedRevision: task.revision, ...PROPOSAL }),
      ],
      person,
    );
    expect(proposed.code, proposed.stdout).toBe(0);
    const gate = detailOf(proposed);
    const decided = await runCli(
      [
        'task.decide',
        '--json',
        JSON.stringify({
          gateId: gate['gateId'],
          versionId: gate['versionId'],
          decision: 'approve',
          note: 'approved for the command-line agent',
        }),
      ],
      person,
    );
    expect(decided.code, decided.stdout).toBe(0);
    const reservationId = String(detailOf(decided)['reservationId']);

    const agent = as(world.agent.token, { OPS_ASTRO_AGENT: '1' });
    const bare = await runCli(
      ['task.create', '--json', JSON.stringify({ fields: { title: 'bare' } })],
      agent,
    );
    expect(bare.code).toBe(1);
    expect(bare.json).toMatchObject({ refused: true, code: 'DELEGATION_EXCLUDES_OPERATION' });

    const queue = await runCli(['task.queue'], agent);
    expect(queue.code, queue.stdout).toBe(0);
    expect(queue.stdout).toContain(reservationId);

    const pickup = await runCli(
      ['task.pickup', '--agent', '--json', JSON.stringify({ reservationId })],
      as(world.agent.token),
    );
    expect(pickup.code, pickup.stdout).toBe(0);
    const credential = readFileSync(join(scratch, 'delegation'), 'utf8').trim();
    expect(credential).not.toBe('');
    const held = detailOf(pickup);
    expect(held['credential']).toBe(`(saved to ${join(scratch, 'delegation')})`);
    expectNoCredential(pickup, credential);
    const lease = { leaseId: held['leaseId'], fence: held['fence'] };
    const leaseRow = async () =>
      (
        await world.db.admin.execute<{ readonly state: string; readonly released: boolean }>(
          'select state, released_at is not null as released from public.leases where id = $1',
          [lease.leaseId],
        )
      )[0];
    expect((await leaseRow())?.state).toBe('live');

    const beat = await runCli(['task.heartbeat', '--json', JSON.stringify(lease)], agent);
    expect(beat.code, beat.stdout).toBe(0);
    expectNoCredential(beat, credential);

    const handback = await runCli(
      [
        'task.handback',
        '--json',
        JSON.stringify({ ...lease, outcome: 'completed', report: { wrote: 'a draft' } }),
      ],
      agent,
    );
    expect(handback.code, handback.stdout).toBe(0);
    expectNoCredential(handback, credential);
    const after = await leaseRow();
    expect(after?.state).not.toBe('live');
    expect(after?.released).toBe(true);
  }, 120_000);

  it('login does the password grant against the identity provider and the bearer it saves works', async () => {
    // The identity provider is the one piece not run for real here: a stand-in
    // answering GoTrue's password-grant shape with a bearer the served API's
    // production verifier accepts. The API and the command line are real.
    let seen: { url: string; body: string } | undefined;
    const gotrue: Server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        seen = { url: request.url ?? '', body };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ access_token: world.ada.token }));
      });
    });
    await new Promise<void>((resolve) => {
      gotrue.listen(0, '127.0.0.1', resolve);
    });
    const address = gotrue.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const env: Record<string, string> = {
        ...as(''),
        OPS_ASTRO_GOTRUE_URL: `http://127.0.0.1:${String(port)}/auth/v1`,
      };
      delete env['OPS_ASTRO_TOKEN'];
      const login = await runCli(['login', '--email', 'ada@example.test'], env, 'a-password\n');
      expect(login.code, login.stderr).toBe(0);
      expect(seen?.url).toBe('/auth/v1/token?grant_type=password');
      expect(JSON.parse(seen?.body ?? '{}')).toStrictEqual({
        email: 'ada@example.test',
        password: 'a-password',
      });
      expectNoCredential(login, 'a-password');

      const people = await runCli(['person.list'], env);
      expect(people.code, people.stdout).toBe(0);
      expect(people.stdout).toContain(String(world.mia.personId));

      const logout = await runCli(['logout'], env);
      expect(logout.code).toBe(0);
      expect((await runCli(['person.list'], env)).code).toBe(2);
    } finally {
      await new Promise<void>((resolve) => {
        gotrue.close(() => resolve());
      });
    }
  }, 60_000);
});
