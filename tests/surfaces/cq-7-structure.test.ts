// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-7's two structural lines, read from the source.
//
// No shadow types: the web and the command line take the read results from
// the server's `packages/core-wire/src/views.ts`, and neither declares a type the server
// already declares, by name or by shape. A copy under a new name is still a
// copy, so a declaration whose fields are exactly a server type's fields fails
// too.
//
// Component size: the task page and every component it mounts is at most 150
// lines, and `proposals.tsx` is under 500.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const VIEWS = 'packages/core-wire/src/views.ts';
const CLIENT_ROOTS = ['apps/web/src', 'apps/cli'];

/** Every `interface X` and `type X = {` in a source, with its own top-level field names. */
function declarations(source: string): Map<string, ReadonlySet<string>> {
  const found = new Map<string, ReadonlySet<string>>();
  const head = /^(?:export )?(?:interface (\w+)[^{]*|type (\w+)(?:<[^=]*>)? = )\{/gmu;
  for (const match of source.matchAll(head)) {
    const name = match[1] ?? match[2] ?? '';
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      if (source[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    const body = source.slice(match.index + match[0].length, end);
    const fields = new Set<string>();
    let level = 0;
    for (const line of body.split('\n')) {
      const field = /^\s*(?:readonly )?['"]?([\w.]+)['"]?\??:/u.exec(line);
      if (level === 0 && field !== null) fields.add(field[1] ?? '');
      level += (line.match(/[{(]/gu) ?? []).length - (line.match(/[})]/gu) ?? []).length;
    }
    found.set(name, fields);
  }
  return found;
}

function sources(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/u.test(entry) ? [path] : [];
  });
}

const sameFields = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((field) => b.has(field));

describe('CQ-7 no shadow types', () => {
  it('has no apps/web/src/operations/shapes.ts', () => {
    expect(existsSync('apps/web/src/operations/shapes.ts')).toBe(false);
  });

  it('declares no server read type again in the web or the command line', () => {
    const server = declarations(readFileSync(VIEWS, 'utf8'));
    expect(server.size).toBeGreaterThan(20);
    const shadows: string[] = [];
    for (const file of CLIENT_ROOTS.flatMap(sources)) {
      for (const [name, fields] of declarations(readFileSync(file, 'utf8'))) {
        const twin = [...server].find(
          ([serverName, serverFields]) =>
            serverName === name || (fields.size >= 3 && sameFields(fields, serverFields)),
        );
        if (twin !== undefined) shadows.push(`${file}: ${name} copies ${twin[0]}`);
      }
    }
    expect(shadows).toEqual([]);
  });

  it('catches a copy under another name', () => {
    const copy = declarations(
      'export interface QueueEntryWire {\n  readonly reservationId: string;\n' +
        '  readonly taskId: string;\n  readonly runId: string;\n  readonly versionId: string;\n' +
        '  readonly lineageId: string;\n  readonly purpose: string;\n  readonly heldMinor: number;\n}\n',
    ).get('QueueEntryWire');
    const queued = declarations(readFileSync(VIEWS, 'utf8')).get('QueuedWork');
    expect(copy).toBeDefined();
    expect(queued).toBeDefined();
    expect(sameFields(copy ?? new Set(), queued ?? new Set())).toBe(true);
  });

  it('takes the read types from the wire package and nothing but types from the command index', () => {
    const reads =
      /import type \{[^}]*\b(?:Task(?:Summary|ReadResult)|BoardTask)\b[^}]*\} from '[./]*packages\/core-wire\/src\/index\.ts';/u;
    expect(readFileSync('apps/web/src/screens/Projects.tsx', 'utf8')).toMatch(reads);
    expect(readFileSync('apps/web/src/screens/TaskDetail.tsx', 'utf8')).toMatch(reads);
    for (const file of CLIENT_ROOTS.flatMap(sources)) {
      const source = readFileSync(file, 'utf8');
      // The command index reaches the database: a client may take types from
      // it, which the build erases, and never a value.
      expect(source, file).not.toMatch(/import (?!type)[^;]*core-commands\/src\/index\.ts/u);
      expect(source, file).not.toMatch(/from '[^']*core-commands\/src\/(?!index\.ts)/u);
    }
  });
});

/** Each top-level function in a source and its length in lines, closing brace included. */
function functionLengths(source: string): Map<string, number> {
  const lines = source.split('\n');
  const lengths = new Map<string, number>();
  lines.forEach((line, start) => {
    const opened = /^(?:export )?function (\w+)/u.exec(line);
    if (opened === null) return;
    const end = lines.findIndex((candidate, at) => at > start && candidate === '}');
    lengths.set(opened[1] ?? '', end - start + 1);
  });
  return lengths;
}

// Every component the task page mounts: the page itself, everything under
// `screens/task/` (read from the directory, so a new part is covered the day
// it lands) and the proposal views.
const SPLIT = [
  'apps/web/src/screens/TaskDetail.tsx',
  'apps/web/src/screens/SharedTaskDetail.tsx',
  ...sources('apps/web/src/screens/task').toSorted(),
  'apps/web/src/views/proposals.tsx',
  'apps/web/src/views/proposal-record.tsx',
  'apps/web/src/views/propose-form.tsx',
];

describe('CQ-7 component size', () => {
  it('covers Comments and every other part under screens/task', () => {
    expect(SPLIT).toContain('apps/web/src/screens/task/Comments.tsx');
    expect(SPLIT).toContain('apps/web/src/screens/task/Notices.tsx');
  });

  it.each(SPLIT)('keeps every component in %s to 150 lines', (file) => {
    expect(existsSync(file), file).toBe(true);
    const long = [...functionLengths(readFileSync(file, 'utf8'))].filter(([, n]) => n > 150);
    expect(long).toEqual([]);
  });

  it('keeps proposals.tsx under 500 lines', () => {
    expect(
      readFileSync('apps/web/src/views/proposals.tsx', 'utf8').split('\n').length,
    ).toBeLessThan(500);
  });

  it('measures a function to its closing brace', () => {
    const body = Array.from({ length: 151 }, () => '  x;').join('\n');
    expect(functionLengths(`function Long() {\n${body}\n}\n`).get('Long')).toBe(153);
  });
});
