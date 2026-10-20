// SPDX-License-Identifier: AGPL-3.0-only
//
// A verb line's refusals come before anything is read or sent. `prepare`
// (`apps/cli/verbs.ts`) refuses a bad verb line, and a whole line through
// `main` refuses a bad connection, while every `node:fs` call and every fetch
// is recorded and refused. A valid line's request, from `prepare`, is the
// body `createVerbCli`'s `run` sends.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../apps/cli/main.ts';
import { createVerbCli, prepare } from '../../apps/cli/verbs.ts';

const trip = vi.hoisted(() => ({ armed: false, touched: [] as string[] }));

vi.mock('node:fs', async (original) => {
  const real = await original<Record<string, unknown>>();
  const wired = Object.fromEntries(
    Object.entries(real).map(([name, value]) => [
      name,
      typeof value === 'function'
        ? (...args: unknown[]): unknown => {
            if (!trip.armed) return (value as (...a: unknown[]) => unknown)(...args);
            trip.touched.push(name);
            throw new Error(`node:fs ${name} called`);
          }
        : value,
    ]),
  );
  return { ...wired, default: wired };
});

beforeEach(() => {
  trip.touched.length = 0;
  vi.stubGlobal('fetch', async () => {
    trip.touched.push('fetch');
    return await Promise.reject(new TypeError('fetch refused'));
  });
  trip.armed = true;
});

afterEach(() => {
  trip.armed = false;
  vi.unstubAllGlobals();
});

const VERB_REFUSALS = [
  { name: 'an unknown verb flag', argv: ['task', 'create', '--title', 'T', '--envv', 'x'] },
  { name: 'an unknown verb', argv: ['task', 'frobnicate'] },
  { name: 'an extra argument', argv: ['map', 'view', 'M-1', 'M-2'] },
  { name: '--title missing', argv: ['task', 'create'] },
  { name: 'a verb flag with no value', argv: ['task', 'create', '--title'] },
  { name: '--revision not whole', argv: ['task', 'update', 'T-1', '--revision', '1.5'] },
  { name: '--detail not a level', argv: ['task', 'get', 'T-1', '--detail', 'most'] },
  { name: 'no task id', argv: ['task', 'comment', '--revision', '1', '--text', 't'] },
  { name: '--operation on a read', argv: ['task', 'get', 'T-1', '--operation', 'op-1'] },
] as const;

describe('prepare refuses a bad verb line without reading', () => {
  VERB_REFUSALS.forEach((one) => {
    it(one.name, () => {
      const prepared = prepare(one.argv, false);
      trip.armed = false;
      expect(prepared).toMatchObject({ exit: 2 });
      expect(trip.touched).toStrictEqual([]);
    });
  });

  it('help, without reading', () => {
    const prepared = prepare(['help'], true);
    trip.armed = false;
    expect(prepared).toMatchObject({ exit: 0 });
    expect(trip.touched).toStrictEqual([]);
  });
});

const ELSEWHERE = 'https://elsewhere.example.test';
const ENV = { OPS_ASTRO_TOKEN_FILE: '/nonexistent/token', OPS_ASTRO_BUSINESS: 'alpha' };
const LINE_REFUSALS = [
  ...VERB_REFUSALS.map((one) => ({ name: one.name, argv: one.argv, env: {} })),
  ...['api', 'gotrue', 'web', 'env', 'business'].flatMap((flag) => [
    { name: `--${flag} with no value`, argv: ['task', 'list', `--${flag}`], env: {} },
    { name: `--${flag}= empty`, argv: ['task', 'list', `--${flag}=`], env: {} },
  ]),
  { name: 'an unknown preset', argv: ['task', 'list', '--env', 'staging'], env: {} },
  ...['api', 'gotrue', 'web'].map((flag) => ({
    name: `--${flag} beside a preset`,
    argv: ['task', 'list', '--env', 'sandbox', `--${flag}=${ELSEWHERE}`],
    env: {},
  })),
  ...['OPS_ASTRO_API_URL', 'OPS_ASTRO_TOKEN', 'OPS_ASTRO_DELEGATION'].map((variable) => ({
    name: `${variable} beside a preset`,
    argv: ['task', 'list', '--agent'],
    env: { OPS_ASTRO_ENV: 'production', [variable]: 'hand-set' },
  })),
  {
    name: 'no business',
    argv: ['task', 'list', '--env', 'sandbox'],
    env: { OPS_ASTRO_BUSINESS: '' },
  },
];

describe('a verb line through main refuses before any read or request', () => {
  LINE_REFUSALS.forEach((one) => {
    it(one.name, async () => {
      const code = await main(
        one.argv,
        { ...ENV, ...one.env },
        {
          out: () => null,
          err: () => null,
          stdin: async () => await Promise.resolve(''),
        },
      );
      trip.armed = false;
      expect(code).toBe(2);
      expect(trip.touched).toStrictEqual([]);
    });
  });
});

it('a valid line is prepared without reading, and run sends that same request', async () => {
  const argv = ['task', 'create', '--title', 'T', '--description', 'D', '--operation', 'op-1'];
  const prepared = prepare(argv, false);
  trip.armed = false;
  expect(trip.touched).toStrictEqual([]);
  expect(prepared).toMatchObject({
    row: { command: 'task.create' },
    request: { operationId: 'op-1', fields: { title: 'T', description: 'D' } },
  });
  const bodies: string[] = [];
  const cli = createVerbCli({
    businessKey: 'alpha',
    credential: 'bearer',
    transport: async (_path, body) => {
      bodies.push(body);
      return await Promise.resolve(Response.json({ recordId: 'r', revision: 1 }));
    },
  });
  expect((await cli.run(argv)).exit).toBe(0);
  expect(bodies.map((body) => JSON.parse(body) as unknown)).toStrictEqual([
    (prepared as { request: unknown }).request,
  ]);
});
