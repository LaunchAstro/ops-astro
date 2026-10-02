// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5 item 7: the authenticated API scan reads an OpenAPI document generated
// from the command surface (`scripts/security/api-definition.ts`), so every
// route the API serves is scanned and none is written by hand.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  COMMAND_SURFACE,
  NEEDS_NO_EXPECTED_REVISION,
  pathOf,
  PREFIX,
  type CommandDeclaration,
} from '../../packages/core-wire/src/surface.ts';
import {
  apiDefinition,
  DefinitionRefused,
  onlyTarget,
  type ApiDefinition,
} from '../../scripts/security/api-definition.ts';

const TARGET = 'https://staging.example.test';

const operation = (doc: ApiDefinition, path: string) => doc.paths[path]?.post;

it('every command on the surface is one POST route under the business, and nothing else is', () => {
  const doc = apiDefinition(TARGET, 'alpha');
  const want = COMMAND_SURFACE.map((each) => `${PREFIX.person}alpha${pathOf(each.name)}`);
  const posted = Object.entries(doc.paths)
    .filter(([, item]) => item.post !== undefined)
    .map(([path]) => path);
  expect(posted.toSorted()).toStrictEqual(want.toSorted());
  expect(Object.keys(doc.paths)).toContain('/api/health');
  expect(doc.servers).toStrictEqual([{ url: TARGET }]);
  expect(doc.openapi).toBe('3.0.3');
});

it('every route asks for the bearer, and every write names its operation id', () => {
  const doc = apiDefinition(TARGET, 'alpha');
  expect(doc.components.securitySchemes['bearer']).toStrictEqual({
    type: 'http',
    scheme: 'bearer',
  });
  for (const each of COMMAND_SURFACE) {
    const op = operation(doc, `${PREFIX.person}alpha${pathOf(each.name)}`);
    expect(op?.security, each.name).toStrictEqual([{ bearer: [] }]);
    const schema = op?.requestBody.content['application/json'].schema;
    if (each.kind === 'write') expect(schema?.required, each.name).toContain('operationId');
    // The envelope's revision, or one a command declares among its own operands (the settings).
    const declared = each.operands?.['expectedRevision'];
    const revision =
      (each.kind === 'write' &&
        each.targetsExistingRecord &&
        !NEEDS_NO_EXPECTED_REVISION.has(each.name)) ||
      (declared !== undefined && !declared.includes('?'));
    expect(schema?.required?.includes('expectedRevision') ?? false, each.name).toBe(revision);
  }
});

it('each operand kind becomes its JSON type; optional ones are not required, nullable ones admit null', () => {
  const planted = {
    name: 'task.update',
    kind: 'write',
    targetsExistingRecord: false,
    operands: {
      recordId: 'id',
      title: 'text?',
      due: 'text?|null',
      estimate: 'count',
      done: 'flag',
      fields: 'map',
      value: 'any',
    },
  } as unknown as CommandDeclaration;
  const doc = apiDefinition(TARGET, 'alpha', [planted]);
  const schema = operation(doc, '/api/b/alpha/task/update')?.requestBody.content['application/json']
    .schema;
  expect(schema?.properties).toStrictEqual({
    operationId: { type: 'string', format: 'uuid' },
    recordId: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    due: { type: 'string', nullable: true },
    estimate: { type: 'number' },
    done: { type: 'boolean' },
    fields: { type: 'object' },
    value: {},
  });
  expect(schema?.required?.toSorted()).toStrictEqual(
    ['done', 'estimate', 'fields', 'operationId', 'recordId', 'value'].toSorted(),
  );
});

it.each([
  ['a path', 'https://staging.example.test/api'],
  ['a login in the address', 'https://user:pass@example.test'],
  ['a query', 'https://staging.example.test/?a=1'],
  ['plain http to a public host', 'http://staging.example.test'],
  ['not an address', 'staging'],
  ['another scheme', 'ftp://staging.example.test'],
])('a target with %s is refused', (_label, target) => {
  expect(() => apiDefinition(target, 'alpha')).toThrow(DefinitionRefused);
});

it('plain http is accepted on this machine only, for the local dry run', () => {
  expect(apiDefinition('http://127.0.0.1:8799', 'alpha').servers).toStrictEqual([
    { url: 'http://127.0.0.1:8799' },
  ]);
});

it.each([['Alpha'], ['al/pha'], [''], ['alpha?x']])(
  'a business key %j is refused, so no route can leave the business path',
  (key) => {
    expect(() => apiDefinition(TARGET, key)).toThrow(DefinitionRefused);
  },
);

it('the job scans only the staging address its environment names', () => {
  expect(() => onlyTarget(TARGET, 'https://staging.example.test/')).not.toThrow();
  expect(() => onlyTarget('https://production.example.test', TARGET)).toThrow(DefinitionRefused);
  expect(() => onlyTarget('https://staging.example.test:8443', TARGET)).toThrow(DefinitionRefused);
  expect(() => onlyTarget(TARGET, '')).toThrow(DefinitionRefused);
});

const dir = mkdtempSync(join(tmpdir(), 'sec-scan-api-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('the command writes the document, and refuses a bad target with exit 1', () => {
  const out = join(dir, 'api.json');
  const made = spawnSync(
    process.execPath,
    [
      'scripts/security/api-definition.mjs',
      '--target',
      TARGET,
      '--business',
      'alpha',
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(made.status, made.stderr).toBe(0);
  const doc = JSON.parse(readFileSync(out, 'utf8')) as ApiDefinition;
  expect(Object.keys(doc.paths).length).toBe(COMMAND_SURFACE.length + 1);
  const refused = spawnSync(
    process.execPath,
    [
      'scripts/security/api-definition.mjs',
      '--target',
      'http://x.test',
      '--business',
      'alpha',
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(refused.status).toBe(1);
  const elsewhere = spawnSync(
    process.execPath,
    [
      'scripts/security/api-definition.mjs',
      '--target',
      'https://production.example.test',
      '--only',
      TARGET,
      '--business',
      'alpha',
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(elsewhere.status).toBe(1);
  expect(elsewhere.stderr).toContain('not the staging address');
});
