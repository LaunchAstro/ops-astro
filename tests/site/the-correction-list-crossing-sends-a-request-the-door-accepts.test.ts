// SPDX-License-Identifier: AGPL-3.0-only
//
// S1922-6 (Sol, PR #1922): the correction-list suite's party-B request is the
// own-client request merged with `atB()`, exactly as C80World.request merges
// it. Both must pass the request's operand check, or the suite's client
// crossing is refused COMMAND_BODY_INVALID before it reaches the separation it
// claims to test. The helpers are read from their committed source.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { transformSync } from '@swc/core';
import { expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { refuseUndescribed } from '../../packages/core-commands/src/commands/operands.ts';

const ref = process.env['SOL1922_SOURCE_REF'];
function source(file: string): string {
  return ref === undefined
    ? readFileSync(file, 'utf8')
    : execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
}
function value(file: string, name: string, bindings: Record<string, unknown>): any {
  const text = source(file);
  const expression = new RegExp(`(?:export )?const ${name}\\s*=([\\s\\S]*?);\\n`, 'u').exec(
    text,
  )?.[1];
  if (!expression) throw new Error(`missing ${name} in ${file}`);
  const js = transformSync(`const result = (${expression});`, {
    jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
  }).code;
  return new Function(...Object.keys(bindings), `${js}\nreturn result;`)(
    ...Object.values(bindings),
  );
}
const partyA = '11111111-1111-4111-8111-111111111111';
const partyB = '22222222-2222-4222-8222-222222222222';
const taskA = '33333333-3333-4333-8333-333333333333';
const taskB = '44444444-4444-4444-8444-444444444444';

it('the correction list suite’s client crossing sends a request the door accepts', () => {
  const operands = value(
    'packages/core-wire/src/surface-live-correction.ts',
    'LIVE_CORRECTION_OPERANDS',
    {},
  );
  const declaration = {
    ...COMMAND_SURFACE.find((row) => row.name === 'live_correction.request')!,
    operands: operands['live_correction.request'],
  };
  const requestBody = value('tests/site/c80-world.ts', 'requestBody', {
    PAGE: 'https://a.example/about/',
    ABOUT: 'src/pages/about.md',
    BEFORE: 'friendly',
    AFTER: 'welcoming',
  });
  const atB = value(
    'tests/site/a-correction-list-answers-only-what-its-reader-reaches.test.ts',
    'atB',
    {
      r: { w: { partyB, taskB } },
      B_PAGE: 'https://b.example/about/',
      B_FILE: 'src/pages/about-b.md',
    },
  );
  const own = requestBody(partyA, taskA);
  expect(refuseUndescribed(own, declaration), 'positive own-client request').toBeUndefined();
  // Exact merge performed by C80World.request in commands(): no edited substitute fields.
  const crossing = { ...own, ...atB() };
  expect(
    refuseUndescribed(crossing, declaration),
    'the committed atB request must reach the handler before testing client separation',
  ).toBeUndefined();
});
