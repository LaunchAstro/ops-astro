// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one served API, the calls that share it */
//
// API-3 through the real entry: `node apps/cli/main.ts task ...` as its own
// process against the production server entry on its own port. The owner
// check's flow (a task, two subtasks, one blocked by the other, a comment)
// runs from the terminal exactly as a person or agent would type it. The
// blocking and resolution go through their named verbs.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import { runCli, serveApi, type Run, type ServedApi } from './cli-process-harness.ts';

const ID = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) r(\d+)\b/u;

function wrote(run: Run): { readonly id: string; readonly revision: string } {
  const match = ID.exec(run.stdout);
  if (run.code !== 0 || match === null) {
    throw new Error(`not a write: ${String(run.code)} ${run.stdout} ${run.stderr}`);
  }
  return { id: match[1] as string, revision: match[2] as string };
}

describe.skipIf(serverUrl === undefined)('API-3 verbs as a separate process', () => {
  let world: World;
  let api: ServedApi | undefined;
  let scratch: string;

  const as = (token: string) => ({
    OPS_ASTRO_API_URL: (api as ServedApi).origin,
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_TOKEN: token,
    OPS_ASTRO_TOKEN_FILE: join(scratch, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
  });

  beforeAll(async () => {
    world = await createWorld('api3proc');
    scratch = mkdtempSync(join(tmpdir(), 'api-3-process-'));
    api = await serveApi(world);
  }, 120_000);

  afterAll(async () => {
    await api?.stop();
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    await world?.close();
  }, 60_000);

  it('API-3 CLI help lists every verb and sends nothing', async () => {
    const run = await runCli(['help'], {});
    expect(run.code, run.stderr).toBe(0);
    for (const verb of ['task get', 'task list', 'task create', 'task comment', 'map frontier']) {
      expect(run.stdout).toContain(verb);
    }
  });

  it('six named verbs against the served API each make one HTTP round trip', async () => {
    let requests = 0;
    const proxy = createServer(async (request, response) => {
      requests += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const answer = await fetch(`${(api as ServedApi).origin}${request.url ?? ''}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: request.headers.authorization ?? '',
        },
        body: Buffer.concat(chunks),
      });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(await answer.text());
    });
    await new Promise<void>((resolve) => {
      proxy.listen(0, '127.0.0.1', resolve);
    });
    const address = proxy.address();
    if (address === null || typeof address === 'string') throw new Error('no loopback port');
    const env = { ...as(world.ada.token), OPS_ASTRO_API_URL: `http://127.0.0.1:${address.port}` };
    const call = async (args: string[]) => {
      const before = requests;
      const run = await runCli(args, env);
      expect(requests - before, args.slice(0, 2).join(' ')).toBe(1);
      return wrote(run);
    };
    const revision = async (id: string) => {
      const rows = await world.db.admin.execute<{ readonly revision: string }>(
        'select revision::text as revision from public.records where business_id = $1 and id = $2',
        [world.alpha, id],
      );
      return rows[0]?.revision ?? '';
    };
    const chartFile = join(scratch, 'six-chart.json');
    const graduateFile = join(scratch, 'six-graduate.json');
    writeFileSync(
      chartFile,
      JSON.stringify({ title: 'Process map', tickets: [], fog: ['Process fog'] }),
    );
    writeFileSync(graduateFile, JSON.stringify({ tickets: [{ title: 'From fog', type: 'task' }] }));
    try {
      const map = await call(['map', 'chart', '--body-file', chartFile]);
      const one = await call(['task', 'create', '--title', 'Process one', '--parent', map.id]);
      const two = await call(['task', 'create', '--title', 'Process two', '--parent', map.id]);
      const blocked = await call([
        'task',
        'block',
        two.id,
        '--revision',
        two.revision,
        '--blocked-by',
        one.id,
      ]);
      const claimed = await call(['task', 'claim', one.id, '--revision', one.revision]);
      await call([
        'task',
        'resolve',
        one.id,
        '--revision',
        claimed.revision,
        '--answer',
        'Process answer',
        '--gist',
        'Process gist',
      ]);
      await call([
        'task',
        'close',
        two.id,
        '--revision',
        blocked.revision,
        '--reason',
        'Outside process map',
      ]);
      const patches = await world.db.admin.execute<{ readonly id: string }>(
        "select id::text as id from public.map_components where business_id = $1 and map_id = $2 and kind = 'fog' and retired_version is null",
        [world.alpha, map.id],
      );
      expect(patches).toHaveLength(1);
      await call([
        'map',
        'graduate',
        map.id,
        '--revision',
        await revision(map.id),
        '--patch',
        patches[0]?.id ?? '',
        '--body-file',
        graduateFile,
      ]);
      const shown = await runCli(['map', 'frontier', map.id, '--json'], env);
      expect(shown.code, shown.stderr).toBe(0);
      expect(shown.json).toMatchObject({
        fog: [],
        frontier: [expect.objectContaining({ title: 'From fog' })],
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }, 60_000);

  it('API-3 CLI owner check flow from the terminal', async () => {
    const env = as(world.ada.token);
    const parent = wrote(
      await runCli(['task', 'create', '--title', 'from the terminal', '--type', 'map'], env),
    );
    const one = wrote(
      await runCli(['task', 'create', '--title', 'sub one', '--parent', parent.id], env),
    );
    const two = wrote(
      await runCli(['task', 'create', '--title', 'sub two', '--parent', parent.id], env),
    );
    wrote(
      await runCli(
        ['task', 'block', two.id, '--revision', two.revision, '--blocked-by', one.id],
        env,
      ),
    );
    const commented = wrote(
      await runCli(['task', 'comment', one.id, '--revision', one.revision, '--text', 'on it'], env),
    );
    const shown = await runCli(['task', 'get', two.id, '--detail', 'standard'], env);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`blockedBy: ${one.id}`);
    wrote(
      await runCli(
        [
          'task',
          'resolve',
          one.id,
          '--revision',
          commented.revision,
          '--answer',
          'Finished from the terminal',
          '--gist',
          'Terminal proof finished',
        ],
        env,
      ),
    );
    const resolved = await runCli(['task', 'get', one.id, '--detail', 'full', '--json'], env);
    expect(resolved.code, resolved.stderr).toBe(0);
    expect(resolved.json).toMatchObject({
      state: { machineCategory: 'completed' },
      comments: expect.arrayContaining([
        expect.objectContaining({ body: 'Finished from the terminal' }),
      ]),
    });
    const refused = await runCli(['task', 'get', two.id], as(world.noah.token));
    expect(refused.code).toBe(1);
    expect(refused.stdout.trim().split('\n')).toHaveLength(1);
  }, 60_000);
});
