// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-6, the parts proved from the source and the surface table: no body cast
// at the boundary or in the preparation, every row describing its operands and
// the parse against them, and the identity, register, replay and settling
// written once. The behaviour on both prefixes is `tests/api/cq-6.test.ts`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_SURFACE, declarationOf } from '../../packages/core-wire/src/index.ts';
import { isReadName } from '../../packages/core-commands/src/index.ts';
import { parseRequest } from '../../packages/core-commands/src/commands/operands.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const COMMANDS = join(ROOT, 'packages/core-commands/src/commands');
const source = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
/** The code without its comments, so a comment naming a pattern is not a use of it. */
const code = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/^\s*\/\/.*$/gmu, '');
const commandFiles = (): readonly string[] =>
  readdirSync(COMMANDS).filter((name) => name.endsWith('.ts'));
const filesUsing = (pattern: string): readonly string[] =>
  commandFiles().filter((name) =>
    code(readFileSync(join(COMMANDS, name), 'utf8')).includes(pattern),
  );

describe('CQ-6 no casts', () => {
  it('apps/api/app.ts casts no body to a request type', () => {
    const app = code(source('apps/api/app.ts'));
    for (const cast of ['as CommandRequest', 'as AgentRequest', 'as ReadRequest']) {
      expect(app, cast).not.toContain(cast);
    }
  });

  it('prepare.ts has no `as unknown as`', () => {
    expect(code(source('packages/core-commands/src/commands/prepare.ts'))).not.toContain(
      'as unknown as',
    );
  });
});

describe('CQ-6 operands described', () => {
  it('every write row describes its operands, and every read row has its catalogue row', () => {
    for (const row of COMMAND_SURFACE) {
      if (row.kind === 'read') expect(isReadName(row.name), row.name).toBe(true);
      else expect(row.operands, row.name).toBeTypeOf('object');
    }
  });

  it('a body that matches its row parses to the request; one that does not is refused by name', () => {
    const rank = declarationOf('task.rank');
    const good = {
      command: 'task.rank' as const,
      operationId: 'op-cq6-good',
      recordId: 'r',
      afterId: null,
    };
    expect(parseRequest(good, rank)).toStrictEqual({ request: good });
    const bad = { ...good, afterId: 5, beforeId: ['x'] };
    expect(parseRequest(bad, rank)).toMatchObject({
      refusal: { code: 'FIELD_VALUE_INVALID', names: ['afterId', 'beforeId'] },
      afterTarget: false,
    });
  });
});

describe('CQ-6 operands refused after the target', () => {
  it('a mistyped non-identifier operand answers after the target, in its own fix', () => {
    const update = declarationOf('task.update');
    const parsed = parseRequest(
      {
        command: 'task.update' as const,
        operationId: 'op-cq6-map',
        recordId: 'r',
        fields: 'title',
      },
      update,
    );
    expect(parsed).toMatchObject({
      refusal: {
        code: 'FIELD_VALUE_INVALID',
        names: ['fields'],
        fixes: ['Send fields as an object of field keys to values, such as { title }.'],
      },
      afterTarget: true,
    });
  });

  it('a target that is not a string names nothing (root ruling 2)', () => {
    const parsed = parseRequest(
      { command: 'task.complete' as const, operationId: 'op-cq6-rec', recordId: 42 },
      declarationOf('task.complete'),
    );
    expect(parsed).toMatchObject({ refusal: { code: 'NOT_FOUND' }, afterTarget: true });
  });
});

describe('CQ-6 one envelope', () => {
  it('the identity check, register lookup, replay and refusal settling each live in one file', () => {
    expect(filesUsing('OPERATION_ID.test(')).toStrictEqual(['requests.ts']);
    expect(filesUsing('await lookupAttempt(')).toStrictEqual(['envelope.ts']);
    expect(filesUsing("'OPERATION_ID_REUSED'")).toStrictEqual(['envelope.ts']);
    expect(filesUsing("'OPERATION_ID_REQUIRED'")).toStrictEqual(['envelope.ts']);
    expect(filesUsing("outcome: 'refused'")).toStrictEqual(['envelope.ts']);
    expect(filesUsing("outcome: 'replayed'")).toStrictEqual(['envelope.ts']);
  });

  it('the agent envelope goes through the shared entry rather than its own copy', () => {
    const agent = code(source('packages/core-commands/src/commands/agent-envelope.ts'));
    expect(agent).toContain('await enter(');
    expect(agent).not.toContain('lookupAttempt');
  });
});
