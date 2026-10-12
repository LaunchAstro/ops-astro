// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { apiDefinition } from '../../scripts/security/api-definition.ts';
import { READ_CATALOGUE } from '../../packages/core-commands/src/reads/catalogue.ts';
import { createSourceMutant } from '../support/source-mutant.ts';

// The mutation runs copy database suites, which skip without a database and so prove nothing.
const withDatabase = it.skipIf(databaseUrlFromEnvironment() === undefined);

const graduation = 'tests/connections/mp-14-10a-graduation-read.test.ts';
const identifiers = 'tests/reads/a-read-refuses-identifiers-it-does-not-take.test.ts';
const trees = ['packages', 'apps', 'scripts', 'tests', 'migrations'];

function runCopy(file: string, from: string, to: string, name?: string, suite?: string) {
  const copy = createSourceMutant({ file, from, to, trees });
  try {
    for (const config of ['package.json', 'tsconfig.json', 'vitest.config.ts']) {
      cpSync(config, join(copy.root, config));
    }
    const args = [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      suite ?? (file.startsWith('tests/') ? file : identifiers),
      '--maxWorkers',
      '1',
    ];
    if (name !== undefined) args.push('-t', name);
    const result = spawnSync(process.execPath, args, {
      cwd: copy.root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, OPS_ASTRO_DB_TEMPLATE: 'off' },
    });
    const output = result.stdout + result.stderr;
    if (
      result.error !== undefined ||
      /Cannot find module|Tests.*no tests|No test files/u.test(output)
    ) {
      throw new Error(output, { cause: result.error });
    }
    return { status: result.status, output };
  } finally {
    copy.dispose();
  }
}

withDatabase(
  'the client-list assertion survives the client C case running first',
  () => {
    const source = readFileSync(graduation, 'utf8');
    const first = source.indexOf("  it('MP-14-10a one select drives");
    const second = source.indexOf("  it('MP-14-10a every reachable client");
    const third = source.indexOf("  it('MP-14-10a the client list, graduation rows");
    expect(first >= 0 && second > first && third > second).toBe(true);
    const original = source.slice(first, third);
    const reordered = source.slice(second, third) + source.slice(first, second);
    const result = runCopy(
      graduation,
      original,
      reordered,
      'one select drives|every reachable client',
    );
    expect(result.status, result.output).toBe(0);
  },
  150_000,
);

withDatabase(
  'the expiry proof survives five seconds of host delay before taking its lock',
  () => {
    const source = readFileSync(graduation, 'utf8');
    const expiry = source.indexOf("  it('MP-14-10a core: expiry is judged");
    const after = source.indexOf("  it('MP-14-10a revoking stops", expiry);
    const original = source.slice(expiry, after);
    // This delay models a descheduled worker after the database has filed the mandate.
    const delayed = original.replace(
      /(const mandateId = await seedMandate\([\s\S]*?\);)/u,
      '$1\n    await pause(5000);',
    );
    const result = runCopy(graduation, original, delayed, 'expiry is judged');
    expect(result.status, result.output).toBe(0);
  },
  150_000,
);

withDatabase(
  'the named proof rejects unaudited content-bearing identifier refusals',
  () => {
    const anchor =
      '  if (refusal === undefined && !declarationOf(request.read).audited) return outcome;';
    const result = runCopy(
      'packages/core-commands/src/reads/dispatch.ts',
      anchor,
      "  if (refusal?.code === 'COMMAND_BODY_INVALID') return { ...outcome, tasks: [{ title: 'Sol leaked content' }] };\n" +
        anchor,
    );
    expect(result.output).toContain('a-read-refuses-identifiers-it-does-not-take.test.ts');
    expect(result.status, result.output).not.toBe(0);
  },
  150_000,
);

it('required structured read operands have usable schemas', () => {
  const doc = apiDefinition('https://staging.example.test', 'alpha');
  const breach =
    doc.paths['/api/b/alpha/privacy/draft_breach_notices']?.post?.requestBody.content[
      'application/json'
    ].schema;
  const preset =
    doc.paths['/api/b/alpha/preset/plan']?.post?.requestBody.content['application/json'].schema;
  const recipient = { name: 'The OAIC', address: 'drill@example.test' };
  expect(
    READ_CATALOGUE['privacy.draft_breach_notices'].parse({
      incidentId: '6f1c2a4e-8b3d-4c5a-9e7f-0a1b2c3d4e5f',
      oaic: recipient,
      people: [recipient],
      containment: 'Contained',
      steps: 'Investigate',
    }).ok,
  ).toBe(true);
  expect
    .soft(preset?.properties?.['fields'])
    .toMatchObject({ type: 'array', items: { type: 'object' } });
  expect.soft(breach?.properties?.['oaic']).toMatchObject({
    type: 'object',
    properties: { name: { type: 'string' }, address: { type: 'string' } },
    required: ['name', 'address'],
  });
  expect.soft(breach?.properties?.['people']).toMatchObject({
    type: 'array',
    minItems: 1,
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'string' },
      },
      required: ['name', 'address'],
    },
  });
});

it('the board schema describes the accepted aggregate read', () => {
  const body = { mode: 'aggregate' };
  expect(READ_CATALOGUE['task.board'].parse(body).ok).toBe(true);
  const doc = apiDefinition('https://staging.example.test', 'alpha');
  const schema =
    doc.paths['/api/b/alpha/task/board']?.post?.requestBody.content['application/json'].schema;
  expect(JSON.stringify(schema)).toContain('"mode"');
});

withDatabase(
  'the named tests detect the original ignored-identifier bug',
  () => {
    const result = runCopy(
      'packages/core-commands/src/reads/dispatch.ts',
      'irrelevantIdentifiers(body, row.identifiers, READ_IDENTIFIER_FIELDS)',
      'irrelevantIdentifiers(body, row.identifiers)',
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('COMMAND_BODY_INVALID');
  },
  150_000,
);

it('the named tests detect the original empty-read-schema bug', () => {
  const file = 'scripts/security/api-definition.ts';
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf("  if (command.kind === 'read') {");
  const end = source.indexOf('  const properties:', start);
  expect(start >= 0 && end > start).toBe(true);
  const result = runCopy(
    file,
    source.slice(start, end),
    "  if (command.kind === 'read') return { type: 'object' };\n",
    undefined,
    'tests/operations/the-api-scan-definition-declares-every-reads-operands.test.ts',
  );
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('task.read requires its identifier');
}, 150_000);

withDatabase.each(['edit', 'revive'])(
  'the strengthened mandate tests detect removal of the %s trigger branch',
  (branch) => {
    const file = 'migrations/20261006080000_standing_mandates.sql';
    const source = readFileSync(file, 'utf8');
    const begin = source.indexOf('    if (new.business_id');
    const revoke = source.indexOf('       or (old.revoked_at is not null', begin);
    const revision = source.indexOf('       or new.revision is distinct', revoke);
    expect(begin >= 0 && revoke > begin && revision > revoke).toBe(true);
    const from = branch === 'edit' ? source.slice(begin, revoke) : source.slice(revoke, revision);
    const result = runCopy(
      file,
      from,
      branch === 'edit' ? '    if false\n' : '',
      'a mandate is written once',
      graduation,
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('23001');
  },
  150_000,
);
