// SPDX-License-Identifier: AGPL-3.0-only
//
// U117 (#1746): the core task journey run against a deployed version, the
// moment the owner deploys. The script is run here against a local stand-in
// for the deployed API, never a real one: it names the build `/build.json`
// carries, creates a task, reads it, renames it and trashes it as the
// signed-in made-up admin, and writes one evidence file. It needs an origin
// named on its command line, sends the bearer only to that origin, never
// prints it, and stops at the first step that does not answer as expected.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const SCRIPT = 'scripts/ops/deployed-journeys.ts';
const TOKEN = 'TOKEN-MARKER-u117-5c1f';
const BUILD = 'a1b2c3d4e5f6';

interface Seen {
  readonly path: string;
  readonly auth: string | undefined;
  readonly body: Record<string, unknown>;
}

type Answer = { readonly status: number; readonly body: unknown; readonly location?: string };

const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((done) => {
          server.close(() => {
            done();
          });
        }),
    ),
  );
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
};

/** The stand-in's answer to one path, as the deployed API would give it. */
function answerFor(
  path: string,
  fields: { title?: string } | undefined,
  record: { revision: number; title: string },
): Answer {
  if (path === '/build.json') return { status: 200, body: { build: BUILD } };
  if (path.endsWith('/task/create')) {
    record.title = String(fields?.title);
    return { status: 200, body: { recordId: 't-1', revision: 1 } };
  }
  if (path.endsWith('/task/read')) {
    const task = { id: 't-1', title: record.title, revision: record.revision };
    return { status: 200, body: { ok: true, task } };
  }
  if (path.endsWith('/task/update')) {
    record.revision += 1;
    record.title = String(fields?.title);
    return { status: 200, body: { recordId: 't-1', revision: record.revision } };
  }
  if (path.endsWith('/task/trash'))
    return { status: 200, body: { recordId: 't-1', revision: record.revision + 1 } };
  return { status: 404, body: { refused: true, code: 'NOT_FOUND', names: [], fixes: [] } };
}

/** A stand-in for the deployed API; `answer` may override any path. */
async function deployed(answer?: (path: string) => Answer | undefined) {
  const seen: Seen[] = [];
  const record = { revision: 1, title: '' };
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://x.invalid').pathname;
      const body = await bodyOf(request);
      seen.push({ path, auth: request.headers.authorization, body });
      const fields = body['fields'] as { title?: string } | undefined;
      const chosen = answer?.(path) ?? answerFor(path, fields, record);
      response.writeHead(chosen.status, {
        'content-type': 'application/json',
        ...(chosen.location === undefined ? {} : { location: chosen.location }),
      });
      response.end(JSON.stringify(chosen.body));
    })();
  });
  servers.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, seen };
}

/** Runs the script; answers its exit code, its output and its evidence file. */
async function run(args: readonly string[], token: string | null = TOKEN) {
  const folder = mkdtempSync(join(tmpdir(), 'u117-'));
  folders.push(folder);
  const out = join(folder, 'evidence.json');
  const { OPS_ASTRO_TOKEN: _unset, ...rest } = process.env;
  const env = token === null ? rest : { ...rest, OPS_ASTRO_TOKEN: token };
  const child = spawn(process.execPath, [SCRIPT, ...args, '--out', out], { env });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  const code = await new Promise<number | null>((done) => {
    child.on('close', done);
  });
  const evidence = existsSync(out) ? readFileSync(out, 'utf8') : '';
  return { code, output, evidence };
}

it('names the deployed build, runs create, read, rename and trash, and passes', async () => {
  const api = await deployed();
  const result = await run(['--origin', api.origin, '--business', 'alpha']);
  expect(result.code, result.output).toBe(0);
  const evidence = JSON.parse(result.evidence) as {
    build: string;
    origin: string;
    passed: boolean;
    steps: { name: string; ok: boolean }[];
  };
  expect(evidence.build).toBe(BUILD);
  expect(evidence.origin).toBe(api.origin);
  expect(evidence.passed).toBe(true);
  expect(evidence.steps.map((step) => [step.name, step.ok])).toStrictEqual([
    ['build', true],
    ['task.create', true],
    ['task.read', true],
    ['task.update', true],
    ['task.read renamed', true],
    ['task.trash', true],
  ]);
  const writes = api.seen.filter((each) => /\/(create|update|trash)$/u.test(each.path));
  expect(new Set(writes.map((each) => each.body['operationId'])).size, 'one id per write').toBe(3);
  expect(writes.map((each) => each.path)).toStrictEqual([
    '/api/b/alpha/task/create',
    '/api/b/alpha/task/update',
    '/api/b/alpha/task/trash',
  ]);
  expect(
    api.seen
      .filter((each) => each.path.startsWith('/api/'))
      .every((each) => each.auth === `Bearer ${TOKEN}`),
  ).toBe(true);
  expect(result.output, 'the bearer is never printed').not.toContain(TOKEN);
  expect(result.evidence, 'nor written').not.toContain(TOKEN);
});

it('a deployed version with no build stamp fails before any write', async () => {
  const api = await deployed((path) =>
    path === '/build.json' ? { status: 200, body: { build: 'not-a-commit' } } : undefined,
  );
  const result = await run(['--origin', api.origin, '--business', 'alpha']);
  expect(result.code).toBe(1);
  expect(api.seen.filter((each) => each.path.startsWith('/api/'))).toStrictEqual([]);
  expect(JSON.parse(result.evidence)).toMatchObject({
    passed: false,
    steps: [{ name: 'build', ok: false }],
  });
});

it('stops at the first step that is refused and names it, in the server’s code', async () => {
  const api = await deployed((path) =>
    path.endsWith('/task/update')
      ? { status: 409, body: { refused: true, code: 'VERSION_STALE', names: [], fixes: [] } }
      : undefined,
  );
  const result = await run(['--origin', api.origin, '--business', 'alpha']);
  expect(result.code).toBe(1);
  const evidence = JSON.parse(result.evidence) as {
    passed: boolean;
    steps: { name: string; ok: boolean; code?: string }[];
  };
  expect(evidence.passed).toBe(false);
  expect(evidence.steps.at(-1)).toMatchObject({
    name: 'task.update',
    ok: false,
    code: 'VERSION_STALE',
  });
  expect(
    api.seen.some((each) => each.path.endsWith('/task/trash')),
    'nothing after the refusal',
  ).toBe(false);
});

it('without an origin on the command line, or without a bearer, it sends nothing', async () => {
  const api = await deployed();
  const noOrigin = await run(['--business', 'alpha']);
  expect(noOrigin.code).toBe(2);
  const noToken = await run(['--origin', api.origin, '--business', 'alpha'], null);
  expect(noToken.code).toBe(2);
  expect(api.seen).toStrictEqual([]);
});

it('an origin that is more than scheme and host is refused before anything is sent', async () => {
  const api = await deployed();
  for (const origin of [
    `${api.origin}?x=1`,
    `${api.origin}#top`,
    `${api.origin}/`,
    `${api.origin}/app`,
  ]) {
    // eslint-disable-next-line no-await-in-loop -- one run at a time, each checked
    const result = await run(['--origin', origin, '--business', 'alpha']);
    expect(result.code, origin).toBe(2);
  }
  expect(api.seen).toStrictEqual([]);
});

it('a redirect is never followed, so the bearer reaches no other server', async () => {
  const elsewhere = await deployed();
  const api = await deployed((path) =>
    path.endsWith('/task/create')
      ? { status: 307, body: {}, location: `${elsewhere.origin}/api/b/alpha/task/create` }
      : undefined,
  );
  const result = await run(['--origin', api.origin, '--business', 'alpha']);
  expect(result.code).toBe(1);
  expect(elsewhere.seen, 'the other server is never asked').toStrictEqual([]);
});
