// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-5, the static cases: they read the source. The register declares the only
// shape with a code and a refusal flag, and the converters between the old
// shapes are gone with nothing re-spelling a refusal in their place. The
// database cases are in cq-5.test.ts.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { refusalShapes, registryOf } from '../support/refusal-shapes.ts';

const LAYERS = ['packages', 'apps/api'];
const sourcesOf = (roots: readonly string[]): string[] =>
  roots.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/u.test(file) && !file.includes('node_modules'))
      .map((file) => `${root}/${file}`),
  );

describe('CQ-5 the source', () => {
  it('CQ-5 one refusal type: the register declares the only shape with a code and a refusal flag', () => {
    const files = sourcesOf([...LAYERS, 'apps/web', 'apps/cli']);
    const registry = registryOf(files.map((f) => readFileSync(f, 'utf8')));
    const shapes = sourcesOf(LAYERS)
      .flatMap((f) => refusalShapes(f, readFileSync(f, 'utf8'), registry))
      .toSorted();
    // The HTTP door, copying the four wire fields in order; the declaration;
    // and the one constructor's own return.
    expect(shapes).toStrictEqual([
      'apps/api/app.ts:literal',
      'packages/core-records/src/register.ts:CommandRefusal',
      'packages/core-records/src/register.ts:literal',
    ]);
    // The check sees a second shape and a hand-built refusal, so it is not blind.
    const planted =
      'type Second = { readonly refused: true; readonly code: string };\n' +
      "const made = { refused: true, code: 'NOT_FOUND', names: [], fixes: [] };";
    expect(refusalShapes('planted.ts', planted)).toStrictEqual([
      'planted.ts:Second',
      'planted.ts:literal',
    ]);
    // Split across a named type, an interface's `extends` or another file, it is still found.
    const split =
      'type Flag = { readonly refused: true };\n' +
      'export type Joined = Flag & { readonly code: string };\n' +
      'export interface Extended extends Flag { readonly code: string }';
    expect(refusalShapes('split.ts', split)).toStrictEqual([
      'split.ts:Extended',
      'split.ts:Joined',
    ]);
    const elsewhere = registryOf(['export interface Coded { readonly code: string }']);
    expect(
      refusalShapes(
        'b.ts',
        'type Far = Flagged & Coded; type Flagged = { refused: true };',
        elsewhere,
      ),
    ).toStrictEqual(['b.ts:Far']);
    // A name alone is an alias of that type, not a second shape.
    expect(
      refusalShapes(
        'alias.ts',
        'type Same = Second; type Second = { refused: true; code: string };',
      ),
    ).toStrictEqual(['alias.ts:Second']);
  });
});

describe('CQ-5 the source', () => {
  it('the web declares no second refusal shape', () => {
    const declarations = sourcesOf(['apps/web', 'apps/cli'])
      .flatMap((file) => refusalShapes(file, readFileSync(file, 'utf8')))
      .filter((shape) => !shape.endsWith(':literal'))
      .toSorted();
    expect(declarations).toStrictEqual([]);
  });

  it('composed refusal declaration fails uniqueness check', () => {
    const planted =
      'export type SplitRefusal = { readonly refused: true } & { readonly code: string };';
    expect(refusalShapes('planted.ts', planted)).toStrictEqual(['planted.ts:SplitRefusal']);
  });

  it('CQ-5 converters gone: fromRecords, fromIdentity, fromAgentIdentity and fromReasoned, and nothing replaces them', () => {
    const files = sourcesOf([...LAYERS, 'apps/web', 'apps/cli', 'scripts']);
    const texts = files.map((f) => [f, readFileSync(f, 'utf8')] as const);
    const named = /\bfrom(?:Records|Identity|AgentIdentity|Reasoned|PresetPlan)\b/u;
    // A replacement re-spells another refusal: `refuseCommand(x.code, ...)`,
    // or rebuilds one under a constant code from its parts:
    // `refuseCommand('SCOPE_NOT_GRANTED', [], x.refusal.fixes)`.
    const respelled = /refuseCommand\(\s*[\w.]+\.code\b/u;
    const rebuilt = /refuseCommand\((?:[^()]|\([^()]*\))*?\.refusal\.(?:code|names|fixes)\b/u;
    const converts = (t: string) => named.test(t) || respelled.test(t) || rebuilt.test(t);
    expect(texts.filter(([, t]) => converts(t)).map(([f]) => f)).toEqual([]);
    // The rebuild CQ-5's first head had in `shares.ts` is caught.
    const planted = "refusal: refuseCommand('SCOPE_NOT_GRANTED', [], authorised.refusal.fixes)";
    expect(converts(planted)).toBe(true);
  });

  it('share authority denial is not rebuilt', () => {
    const source = readFileSync('packages/core-records/src/authority/shares.ts', 'utf8');
    const rebuilt =
      /refusal:\s*refuseCommand\(\s*'SCOPE_NOT_GRANTED',\s*\[\],\s*authorised\.refusal\.fixes\)/u;
    expect(rebuilt.test(source)).toBe(false);
  });
});
