// SPDX-License-Identifier: AGPL-3.0-only
//
// P3 and the appendix of docs/plan/sandbox-contract.md: a create body is
// structurally equal to its class's fixed body with exactly one slot filled,
// `Image`. A missing key, an added key (the daemon's default value
// included), a changed value or type, and a reordered list are refusals.

import { expect, it } from 'vitest';
import {
  type CreateShape,
  fixedCreateBody,
  matchCreateBody,
} from '../../packages/core-sandbox/src/create-body.ts';
import type { Json } from '../../packages/core-sandbox/src/strict-json.ts';

const IMAGE = `sha256:${'ab'.repeat(32)}`;
const S1_ENV = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp/home', 'NODE_ENV=production'];
const S2_ENV = [
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'HOME=/tmp/home',
  'ASTRO_TELEMETRY_DISABLED=1',
];
const S1: CreateShape = { runClass: 'site.build', env: S1_ENV };
const S2: CreateShape = { runClass: 'site.prepare', env: S2_ENV };
const WALL: CreateShape = {
  runClass: 'probe',
  probed: 'site.build',
  crossing: 'wall',
  env: S1_ENV,
};

/** The appendix body, written out by hand so the builder is checked against the contract's text. */
const APPENDIX_S1 = {
  Image: IMAGE,
  Entrypoint: ['/opt/launcher/entrypoint'],
  Cmd: ['build'],
  User: '10001:10001',
  WorkingDir: '/work',
  Hostname: 'sandbox',
  Env: S1_ENV,
  AttachStdin: true,
  AttachStdout: true,
  AttachStderr: true,
  OpenStdin: true,
  StdinOnce: true,
  Tty: false,
  NetworkDisabled: true,
  Healthcheck: { Test: ['NONE'] },
  Volumes: {},
  Labels: {},
  HostConfig: {
    Runtime: 'runsc',
    NetworkMode: 'none',
    ReadonlyRootfs: true,
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Privileged: false,
    Memory: 1073741824,
    MemorySwap: 1073741824,
    NanoCpus: 1000000000,
    PidsLimit: 256,
    OomScoreAdj: 1000,
    ShmSize: 16777216,
    Tmpfs: { '/work': 'rw,nosuid,nodev,size=402653184', '/tmp': 'rw,nosuid,nodev,size=268435456' },
    LogConfig: { Type: 'none', Config: {} },
    RestartPolicy: { Name: 'no' },
    AutoRemove: false,
    Init: false,
  },
};

type Mutable = Record<string, unknown> & { HostConfig: Record<string, unknown> };
const copy = (): Mutable => structuredClone(APPENDIX_S1) as unknown as Mutable;

it('builds the site.build body exactly as the appendix writes it', () => {
  expect(fixedCreateBody(S1, IMAGE)).toEqual(APPENDIX_S1);
  expect(Object.keys(fixedCreateBody(S1, IMAGE) as object)).toEqual(Object.keys(APPENDIX_S1));
});

it('builds site.prepare from it with only the appendix differences', () => {
  const expected = copy();
  expected['Cmd'] = ['prepare'];
  expected['Env'] = S2_ENV;
  expected.HostConfig['Memory'] = 4294967296;
  expected.HostConfig['MemorySwap'] = 4294967296;
  expected.HostConfig['Tmpfs'] = {
    '/work': 'rw,nosuid,nodev,size=2147483648',
    '/tmp': 'rw,nosuid,nodev,size=1073741824',
  };
  expect(fixedCreateBody(S2, IMAGE)).toEqual(expected);
});

it('builds a probe body as its probed class with the probe command', () => {
  const expected = copy();
  expected['Cmd'] = ['probe', 'site.build', 'wall'];
  expect(fixedCreateBody(WALL, IMAGE)).toEqual(expected);
  const inRun = { runClass: 'probe', probed: 'site.prepare', env: S2_ENV } as const;
  expect((fixedCreateBody(inRun, IMAGE) as { Cmd: Json }).Cmd).toEqual(['probe', 'site.prepare']);
});

it('matches the appendix body and returns its image', () => {
  expect(matchCreateBody(APPENDIX_S1 as Json, [S2, S1])).toEqual({
    ok: true,
    shape: S1,
    image: IMAGE,
  });
});

it('matches each body to its own shape when several are allowed', () => {
  const shapes = [S1, S2, WALL];
  for (const shape of shapes) {
    const result = matchCreateBody(fixedCreateBody(shape, IMAGE), shapes);
    expect(result).toEqual({ ok: true, shape, image: IMAGE });
  }
});

it.each([
  ['uppercase hex', `sha256:${'AB'.repeat(32)}`],
  ['63 hex characters', `sha256:${'a'.repeat(63)}`],
  ['no sha256 prefix', 'ab'.repeat(32)],
  ['a name and tag', 'node:22'],
  ['a list holding a valid id', [`sha256:${'ab'.repeat(32)}`]],
  ['a number', 7],
])('refuses an Image slot holding %s', (_name, image) => {
  const body = copy();
  body['Image'] = image;
  expect(matchCreateBody(body as Json, [S1])).toMatchObject({ ok: false, why: 'image slot' });
});

const mutations: readonly (readonly [string, (body: Mutable) => void])[] = [
  ['a missing top-level key', (b) => delete b['Labels']],
  ['a missing nested key', (b) => delete b.HostConfig['LogConfig']],
  ['an added key holding the daemon default', (b) => (b.HostConfig['Dns'] = [])],
  ['an added top-level key', (b) => (b['StopSignal'] = 'SIGTERM')],
  [
    'an added Tmpfs path',
    (b) => ((b.HostConfig['Tmpfs'] as Record<string, string>)['/var'] = 'rw'),
  ],
  ['a bind mount', (b) => (b.HostConfig['Binds'] = ['/:/host'])],
  ['network mode bridge', (b) => (b.HostConfig['NetworkMode'] = 'bridge')],
  [
    'a string spelt as an object keyed by position',
    (b) => (b.HostConfig['NetworkMode'] = { 0: 'n', 1: 'o', 2: 'n', 3: 'e' }),
  ],
  ['the runc runtime', (b) => (b.HostConfig['Runtime'] = 'runc')],
  ['privileged true', (b) => (b.HostConfig['Privileged'] = true)],
  ['memory as a string', (b) => (b.HostConfig['Memory'] = '1073741824')],
  ['memory doubled', (b) => (b.HostConfig['Memory'] = 2147483648)],
  ['a boolean as a number', (b) => (b['Tty'] = 0)],
  ['an extra environment variable', (b) => (b['Env'] = [...S1_ENV, 'NPM_TOKEN=x'])],
  ['the environment reordered', (b) => (b['Env'] = [...S1_ENV].toReversed())],
  ['the site.prepare command on a site.build body', (b) => (b['Cmd'] = ['prepare'])],
  ['an unknown crossing', (b) => (b['Cmd'] = ['probe', 'site.build', 'cpu'])],
  ['an object in place of a list', (b) => (b['Entrypoint'] = { 0: '/opt/launcher/entrypoint' })],
];

it.each(mutations)('refuses %s', (_name, mutate) => {
  const body = copy();
  mutate(body);
  expect(matchCreateBody(body as Json, [S1, WALL])).toMatchObject({
    ok: false,
    reason: 'proxy refused',
    why: 'create body',
  });
});

it('refuses a site.prepare body that carries a site variable', () => {
  const body = fixedCreateBody({ runClass: 'site.prepare', env: [...S2_ENV, 'SITE_URL=x'] }, IMAGE);
  expect(matchCreateBody(body, [S2])).toMatchObject({ ok: false, why: 'create body' });
});

it.each([
  ['a list', [APPENDIX_S1]],
  ['null', null],
])('refuses a body that is %s as a create body', (_name, body) => {
  expect(matchCreateBody(body as Json, [S1])).toMatchObject({ ok: false, why: 'create body' });
});

it('refuses a key named __proto__ in place of an expected key', () => {
  const body = copy();
  delete body['Labels'];
  Object.defineProperty(body, '__proto__', { value: {}, enumerable: true });
  expect(matchCreateBody(body as Json, [S1])).toMatchObject({ ok: false, why: 'create body' });
});

it('refuses an object with a length key in place of a list, without throwing', () => {
  const body = copy();
  body['Entrypoint'] = { length: 1, 0: '/opt/launcher/entrypoint' };
  expect(matchCreateBody(body as Json, [S1])).toMatchObject({ ok: false, why: 'create body' });
});
