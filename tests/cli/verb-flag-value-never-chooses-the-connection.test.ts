// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's proof on #1933 (S1933-1), its assertions unchanged: a verb flag's
// value is data, never a connection option, so a description that begins
// with --env neither chooses the preset nor the bearer; and the business,
// client and person filters and the agent prefix stay separate.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { main } from '../../apps/cli/main.ts';

const QUIET = {
  out: (): null => null,
  err: (): null => null,
  stdin: async (): Promise<string> => await Promise.resolve(''),
};

const folders: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

it('a description beginning with --env stays data and cannot choose the bearer', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sol1933-value-'));
  folders.push(folder);
  const tokenFile = join(folder, 'token');
  writeFileSync(tokenFile, 'manual-test-bearer');
  writeFileSync(`${tokenFile}.production`, 'production-test-bearer');
  const seen: { url: string; bearer: string | null; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    seen.push({
      url: String(input),
      bearer: new Headers(init.headers).get('authorization'),
      body: JSON.parse(String(init.body)),
    });
    return await Promise.resolve(Response.json({ recordId: 'T-1', revision: 1 }));
  });
  const code = await main(
    ['task', 'create', '--title', 'T', '--description', '--env=production', '--json'],
    {
      OPS_ASTRO_TOKEN_FILE: tokenFile,
      OPS_ASTRO_BUSINESS: 'alpha',
    },
    QUIET,
  );
  expect(code).toBe(0);
  expect(seen).toHaveLength(1);
  expect.soft(seen[0]?.url).toBe('http://127.0.0.1:8790/api/b/alpha/task/create');
  expect.soft(seen[0]?.bearer).toBe('Bearer manual-test-bearer');
  expect
    .soft(seen[0]?.body)
    .toMatchObject({ fields: { title: 'T', description: '--env=production' } });
});

it('business routing, client and person filters, and the agent prefix stay separate', async () => {
  const sent: { url: string; delegation: string | null; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    sent.push({
      url: String(input),
      delegation: new Headers(init.headers).get('x-agent-delegation'),
      body: JSON.parse(String(init.body)),
    });
    return await Promise.resolve(Response.json({ page: [] }));
  });
  for (const agent of [false, true]) {
    // eslint-disable-next-line no-await-in-loop -- person, then agent, in order
    const code = await main(
      [
        'task',
        'list',
        '--business',
        'business/other?x',
        '--client',
        'client-A',
        '--person',
        'person-B',
        ...(agent ? ['--agent'] : []),
      ],
      {
        OPS_ASTRO_TOKEN: 'routing-test-bearer',
        OPS_ASTRO_DELEGATION: 'routing-test-delegation',
      },
      QUIET,
    );
    expect(code).toBe(0);
  }
  expect(sent.map((one) => one.url)).toStrictEqual([
    'http://127.0.0.1:8790/api/b/business%2Fother%3Fx/task/board',
    'http://127.0.0.1:8790/api/a/b/business%2Fother%3Fx/task/board',
  ]);
  expect(sent.map((one) => one.delegation)).toStrictEqual([null, 'routing-test-delegation']);
  for (const request of sent)
    expect(request.body).toMatchObject({ client: 'client-A', person: 'person-B' });
});

// The class: any connection option, in any form, given as the value of a verb
// flag stays that flag's value. With OPS_ASTRO_ENV naming the sandbox the line
// still goes to the sandbox with its own bearer, never where the value points.
const SHAPES = [
  '--env=production',
  '--env',
  '--api=https://elsewhere.example.test',
  '--gotrue=https://elsewhere.example.test',
  '--web=https://elsewhere.example.test',
  '--business=beta',
  '--agent',
];
const LINES = [
  {
    name: '--title',
    argv: (v: string) => ['task', 'create', '--title', v],
    field: ['fields', 'title'],
  },
  {
    name: '--description',
    argv: (v: string) => ['task', 'create', '--title', 'T', '--description', v],
    field: ['fields', 'description'],
  },
  {
    name: '--text',
    argv: (v: string) => ['task', 'comment', 'T-1', '--revision', '1', '--text', v],
    field: ['body'],
  },
  { name: '--board', argv: (v: string) => ['task', 'list', '--board', v], field: ['board'] },
];

it.each(LINES.flatMap((line) => SHAPES.map((shape) => ({ line, shape }))))(
  '$line.name given $shape keeps it as data, under the preset the environment names',
  async ({ line, shape }) => {
    const folder = mkdtempSync(join(tmpdir(), 'verb-value-class-'));
    folders.push(folder);
    const tokenFile = join(folder, 'token');
    writeFileSync(`${tokenFile}.sandbox`, 'sandbox-test-bearer');
    writeFileSync(`${tokenFile}.production`, 'production-test-bearer');
    const seen: { url: string; bearer: string | null; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      seen.push({
        url: String(input),
        bearer: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return await Promise.resolve(Response.json({ recordId: 'T-1', revision: 1, page: [] }));
    });
    const code = await main(
      line.argv(shape),
      { OPS_ASTRO_TOKEN_FILE: tokenFile, OPS_ASTRO_BUSINESS: 'alpha', OPS_ASTRO_ENV: 'sandbox' },
      QUIET,
    );
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.startsWith('https://app.opsastro.com/api/b/alpha/')).toBe(true);
    expect(seen[0]?.bearer).toBe('Bearer sandbox-test-bearer');
    const value = line.field.reduce<unknown>(
      (at, key) => (at as Record<string, unknown> | undefined)?.[key],
      seen[0]?.body,
    );
    expect(value).toBe(shape);
  },
);
