// SPDX-License-Identifier: AGPL-3.0-only
//
// The two verbs that read a body file, `map chart` and `map graduate`, keep the
// verb line's rules: a bad line is refused before the file is read, and the
// operation id is the line's own (`--operation`, or a new one), never one the
// file carries, so a file copied from an earlier call can't make a new chart a
// replay of the old one.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepare, type Prepared } from '../../apps/cli/verbs.ts';

let folder: string;
let stale: string;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-body-file-verbs-'));
  stale = join(folder, 'copied.json');
  writeFileSync(stale, JSON.stringify({ title: 'Synthetic map', operationId: 'from-the-file' }));
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

const request = (argv: readonly string[]): Prepared['request'] => {
  const prepared = prepare(argv, false);
  if (!('request' in prepared)) throw new Error(`refused: ${prepared.out}`);
  return prepared.request;
};

describe('map graduate refuses a bad line before it reads the body file', () => {
  it.each([
    [['map', 'graduate', 'M-1', '--patch', 'P-1'], '--revision is needed'],
    [['map', 'graduate', 'M-1', '--revision', '1'], '--patch is needed'],
  ])('%j names the missing flag, not the unread file', (line, refusal) => {
    const gone = join(folder, 'never-written.json');
    expect(prepare([...line, '--body-file', gone], false)).toStrictEqual({
      exit: 2,
      out: `usage: ${refusal}`,
    });
  });
});

describe.each([
  ['map chart', ['map', 'chart']],
  ['map graduate', ['map', 'graduate', 'M-1', '--revision', '1', '--patch', 'P-1']],
])('%s sends its own operation id, never one from the body file', (_verb, line) => {
  it('sends --operation when the line gives one', () => {
    expect(request([...line, '--body-file', stale, '--operation', 'from-the-line'])).toMatchObject({
      operationId: 'from-the-line',
    });
  });

  it('sends a new id when the line gives none', () => {
    const { operationId } = request([...line, '--body-file', stale]);
    expect(typeof operationId).toBe('string');
    expect(operationId).not.toBe('from-the-file');
  });
});
