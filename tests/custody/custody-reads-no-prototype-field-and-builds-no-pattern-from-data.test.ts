// SPDX-License-Identifier: AGPL-3.0-only
//
// Custody's answer filter and route matcher take nothing from data that could
// reach past a plain value: a dotted field never steps through `__proto__`,
// `constructor` or `prototype`, and a template route is matched by literal
// comparison and fixed character checks, never by a pattern built from the
// template or the request.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fieldAt, keptOf } from '../../packages/core-custody/src/egress-answer.ts';
import { parseExtras, templateFilled } from '../../packages/core-custody/src/egress-routes.ts';

const answer = (body: string) =>
  ({ ok: true, status: 200, body, mediaType: 'application/json' }) as const;

it('a dotted field through __proto__, constructor or prototype reads nothing', () => {
  const parsed: unknown = JSON.parse('{"__proto__":{"x":"own"},"a":{"constructor":{"x":"c"}}}');
  expect(fieldAt(parsed, '__proto__.x')).toBeUndefined();
  expect(fieldAt(parsed, 'a.constructor.x')).toBeUndefined();
  expect(fieldAt({ prototype: { x: 'p' } }, 'prototype.x')).toBeUndefined();
  expect(fieldAt(parsed, 'a')).toStrictEqual({ constructor: { x: 'c' } });
});

it('a declared field naming __proto__ keeps nothing, and pollutes nothing', () => {
  const body = '{"__proto__":{"polluted":"yes"},"sha":"abc"}';
  expect(keptOf(answer(body), { '__proto__.polluted': 'string', sha: 'string' })).toBeUndefined();
  expect(keptOf(answer(body), { 'constructor.prototype.polluted': 'string' })).toBeUndefined();
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(keptOf(answer(body), { sha: 'string' })).toStrictEqual({
    body: '{"sha":"abc"}',
    values: ['abc'],
  });
});

it('the route matcher builds no pattern at run time', () => {
  const source = readFileSync(
    join(import.meta.dirname, '../../packages/core-custody/src/egress-routes.ts'),
    'utf8',
  );
  expect(source).not.toMatch(/new RegExp\(|RegExp\(/u);
});

it('a template literal is matched as written, a dot only by a dot', () => {
  const extras = parseExtras({
    key: 'hosting',
    origin: 'https://api.example.com',
    routes: [{ method: 'GET', template: '/v1/a.b/{id}?x={x}', fields: { id: 'string' } }],
  });
  expect(extras).toBeDefined();
  const filled = (path: string) => templateFilled(extras ?? {}, 'GET', path) !== undefined;
  expect(filled('/v1/a.b/dpl_1?x=1')).toBe(true);
  expect(filled('/v1/aXb/dpl_1?x=1')).toBe(false);
  expect(filled('/v1/a.b/dpl_1/more?x=1')).toBe(false);
  expect(filled('/v1/a.b/..?x=1')).toBe(false);
  expect(filled('/v1/a.b/dpl_1?x=1&y=2')).toBe(false);
  expect(filled('/v1/a.b/dpl_1?y=1')).toBe(false);
  expect(filled('/v1/a.b/dpl_1')).toBe(false);
});
