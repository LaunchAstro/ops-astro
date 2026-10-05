// SPDX-License-Identifier: AGPL-3.0-only
//
// The fixed create bodies of docs/plan/sandbox-contract.md (the appendix and
// P3). The proxy compares a create request with its class's body whole: the
// same keys at every level, the same values and types, lists in the same
// order, and exactly one slot filled, `Image`. A key the daemon would fill
// with its default anyway is still a refusal, because the comparison is
// against this body and not against what the daemon would do with it.
//
// The `Env` list is per pin (B3), so the caller passes it in each shape; the
// pin list that holds it is read elsewhere.

import { refuse, type Result } from './refusal.ts';
import type { Json } from './strict-json.ts';

export type Crossing = 'memory' | 'wall' | 'output';
type BuiltClass = 'site.build' | 'site.prepare';

export type CreateShape =
  | { readonly runClass: 'site.build'; readonly env: readonly string[] }
  | { readonly runClass: 'site.prepare'; readonly env: readonly string[] }
  | {
      readonly runClass: 'probe';
      readonly probed: BuiltClass;
      readonly crossing?: Crossing;
      readonly env: readonly string[];
    };

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const GIB = 1024 * 1024 * 1024;

const tmpfs = (work: number, tmp: number) => ({
  '/work': `rw,nosuid,nodev,size=${work}`,
  '/tmp': `rw,nosuid,nodev,size=${tmp}`,
});

/** The built class's memory and scratch sizes: the only host settings that differ. */
const LIMITS: Readonly<Record<BuiltClass, { memory: number; work: number; tmp: number }>> = {
  'site.build': { memory: GIB, work: 384 * 1024 * 1024, tmp: 256 * 1024 * 1024 },
  'site.prepare': { memory: 4 * GIB, work: 2 * GIB, tmp: GIB },
};

const command = (shape: CreateShape): string[] => {
  if (shape.runClass === 'site.build') return ['build'];
  if (shape.runClass === 'site.prepare') return ['prepare'];
  return shape.crossing === undefined
    ? ['probe', shape.probed]
    : ['probe', shape.probed, shape.crossing];
};

export function fixedCreateBody(shape: CreateShape, image: string): Json {
  const limits = LIMITS[shape.runClass === 'probe' ? shape.probed : shape.runClass];
  return {
    Image: image,
    Entrypoint: ['/opt/launcher/entrypoint'],
    Cmd: command(shape),
    User: '10001:10001',
    WorkingDir: '/work',
    Hostname: 'sandbox',
    Env: [...shape.env],
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
      Memory: limits.memory,
      MemorySwap: limits.memory,
      NanoCpus: 1000000000,
      PidsLimit: 256,
      OomScoreAdj: 1000,
      ShmSize: 16777216,
      Tmpfs: tmpfs(limits.work, limits.tmp),
      LogConfig: { Type: 'none', Config: {} },
      RestartPolicy: { Name: 'no' },
      AutoRemove: false,
      Init: false,
    },
  };
}

type JsonObject = { readonly [key: string]: Json };
const isObject = (value: Json): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural equality: same type, same keys (any order), same list order, same scalars. */
export function sameJson(a: Json, b: Json): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item: Json, index) => sameJson(item, b[index] as Json));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key] as Json, b[key] as Json));
  }
  return a === b;
}

export function matchCreateBody(
  body: Json,
  shapes: readonly CreateShape[],
): Result<{ shape: CreateShape; image: string }> {
  if (!isObject(body)) return refuse('create body');
  const image = body['Image'];
  if (typeof image !== 'string' || !IMAGE_ID.test(image)) return refuse('image slot');
  const shape = shapes.find((candidate) => sameJson(body, fixedCreateBody(candidate, image)));
  return shape === undefined ? refuse('create body') : { ok: true, shape, image };
}
