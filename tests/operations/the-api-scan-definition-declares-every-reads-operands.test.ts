// SPDX-License-Identifier: AGPL-3.0-only
//
// The API scan's document (`scripts/security/api-definition.ts`) describes each
// read's body with the operands the read really takes, so the scan can fill in
// and probe them. The live read parsers (`reads/catalogue.ts`) are the measure:
// every operand the document requires is one the read refuses without, and a
// body of the document's operands at valid values is one the read takes.

import { describe, expect, it } from 'vitest';
import { irrelevantIdentifiers } from '../../packages/core-commands/src/commands/prepare.ts';
import { READ_IDENTIFIER_FIELDS } from '../../packages/core-commands/src/commands/operands.ts';
import { READ_CATALOGUE, type ReadName } from '../../packages/core-commands/src/reads/catalogue.ts';
import { pathOf, PREFIX, READS } from '../../packages/core-wire/src/surface.ts';
import { apiDefinition, type Schema } from '../../scripts/security/api-definition.ts';

const doc = apiDefinition('https://staging.example.test', 'alpha');
const READ_NAMES = Object.keys(READ_CATALOGUE) as ReadName[];

function bodyOf(name: string): Schema {
  const schema =
    doc.paths[`${PREFIX.person}alpha${pathOf(name as ReadName)}`]?.post?.requestBody.content[
      'application/json'
    ].schema;
  if (schema === undefined) throw new Error(`${name} has no route in the document`);
  return schema;
}

/** The bodies a read takes: its one body, or each of its forms. */
const formsOf = (schema: Schema): readonly Schema[] => schema.oneOf ?? [schema];

const UUID = '6f1c2a4e-8b3d-4c5a-9e7f-0a1b2c3d4e5f';
const RECIPIENT = { name: 'The OAIC', address: 'drill-oaic@example.test' };

// A valid value for an operand whose shape the kind alone does not give.
const BY_NAME: Readonly<Record<string, unknown>> = {
  detail: 'full',
  page: 'next-page-token',
  query: 'launch plan',
  timeZone: 'Australia/Brisbane',
  before: '2026-01-31',
  digest: 'a'.repeat(64),
  from: '2026-01-01T00:00:00Z',
  to: '2026-02-01T00:00:00Z',
  fields: [],
  oaic: RECIPIENT,
  people: [RECIPIENT],
  cursor: 0,
};

function sampleOf(name: string, schema: Schema): unknown {
  if (Object.hasOwn(BY_NAME, name)) return BY_NAME[name];
  if (schema.enum !== undefined) return schema.enum[0];
  if (schema.format === 'uuid') return UUID;
  if (schema.type === 'string') return 'a value';
  if (schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'object') return {};
  if (schema.type === 'array') return [];
  throw new Error(`no sample for ${name}: give it one in BY_NAME`);
}

/** Every operand the document declares, each at a valid value. */
function fullBody(schema: Schema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([name, each]) => [name, sampleOf(name, each)]),
  );
}

// `conversation.read` parses any body, so a caller holding nothing is refused
// before the identifier is looked at; the read refuses a missing one itself.
const CHECKED_AFTER_THE_DOOR: Readonly<Partial<Record<ReadName, string>>> = {
  'conversation.read': 'conversationId',
};

it('every read on the surface has a described body in the document', () => {
  expect(READ_NAMES.toSorted()).toStrictEqual([...READS].toSorted());
  for (const name of READ_NAMES) {
    for (const form of formsOf(bodyOf(name))) expect(form.properties, name).toBeDefined();
  }
});

it.each([
  ['task.read', ['recordId']],
  ['task.execution', ['recordId']],
  ['trace.read', ['recordId']],
  ['conversation.read', ['conversationId']],
  ['chat.messages', ['conversationId']],
  ['harness.read', ['runId']],
  ['live_correction.read', ['correctionId']],
  ['task.receipt', ['attemptId']],
  ['task.board', ['board']],
])('%s requires its identifier in the document', (name, required) => {
  expect(formsOf(bodyOf(name))[0]?.required).toStrictEqual(required);
});

it.each([
  ['task.read', ['detail', 'limit', 'page', 'historyEventId']],
  ['task.board', ['person', 'client', 'detail', 'limit', 'page']],
  ['task.execution', ['cursor']],
  ['task.todos', ['person', 'client']],
  ['conversation.allowance', ['conversationId']],
  ['conversation.models', ['conversationId']],
])('%s declares its optional operands', (name, optional) => {
  const [schema = {}] = formsOf(bodyOf(name));
  for (const each of optional) {
    expect(Object.keys(schema.properties ?? {}), name).toContain(each);
    expect(schema.required ?? [], name).not.toContain(each);
  }
});

it('the board takes its aggregate form in place of a board, never beside it', () => {
  const [board, aggregate] = formsOf(bodyOf('task.board'));
  expect(aggregate?.required).toStrictEqual(['mode']);
  expect(aggregate?.properties?.['board']).toBeUndefined();
  expect(board?.properties?.['mode']).toBeUndefined();
});

it('a structured operand is described down to its fields', () => {
  const breach = bodyOf('privacy.draft_breach_notices').properties ?? {};
  expect(breach['oaic']?.required).toStrictEqual(['name', 'address']);
  expect(breach['people']).toMatchObject({ type: 'array', minItems: 1 });
  expect(breach['people']?.items?.required).toStrictEqual(['name', 'address']);
  expect(bodyOf('preset.plan').properties?.['fields']).toMatchObject({
    type: 'array',
    items: { type: 'object' },
  });
});

const FORMS = READ_NAMES.flatMap((name) =>
  formsOf(bodyOf(name)).map(
    (schema, index) => [`${name} form ${index + 1}`, name, schema] as const,
  ),
);

describe.each(FORMS)('%s', (_label, name, schema) => {
  const parse = (body: Readonly<Record<string, unknown>>) => READ_CATALOGUE[name].parse(body);

  it('a body of every declared operand at a valid value is taken by the read', () => {
    const body = fullBody(schema);
    const parsed = parse(body);
    expect(parsed.ok ? 'taken' : parsed.refusal, name).toBe('taken');
    expect(
      irrelevantIdentifiers(body, READ_CATALOGUE[name].identifiers, READ_IDENTIFIER_FIELDS),
      name,
    ).toStrictEqual([]);
  });

  it('each operand the document requires is refused by the read when absent', () => {
    for (const required of schema.required ?? []) {
      const { [required]: _absent, ...body } = fullBody(schema);
      const after = CHECKED_AFTER_THE_DOOR[name] === required;
      // A read that checks after the door parses the body; once it refuses here, drop it from the list.
      expect(parse(body).ok, `${name} without ${required}`).toBe(after);
    }
  });
});
