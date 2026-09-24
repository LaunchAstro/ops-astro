// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, lane FR2-DOCS-2: the CLI.md and WEB.md lines the FR2
// CLI, web and runtime lanes handed back, held against the code they describe,
// so a doc line that drifts from it again fails here.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** Prose with its line breaks folded, so a phrase is found across a wrap. */
const folded = (text: string): string => text.replaceAll(/\s+/gu, ' ');

const CLI_DOC = 'docs/local/CLI.md';
const CLI_MAIN = 'apps/cli/main.ts';

/** The exit-code table row of `CLI.md` for `code`. */
function exitRow(code: number): string {
  const row = read(CLI_DOC)
    .split('\n')
    .find((line) => line.startsWith(`| ${String(code)} `));
  if (row === undefined) throw new Error(`CLI.md has no exit-code row ${String(code)}`);
  return row;
}

/** The first `return EXIT.<name>` after `marker` in `main.ts`. */
function exitAfter(marker: string): string {
  const source = read(CLI_MAIN);
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`main.ts has no ${marker}`);
  return /return EXIT\.(\w+)/u.exec(source.slice(at))?.[1] ?? '';
}

describe('CLI.md exit codes (R2-SURFACE-43, R2-SURFACE-65, FR2-CLI-CONT)', () => {
  it('keeps usage at 2 and fault at 4', () => {
    expect(read(CLI_MAIN)).toContain(
      'EXIT = { ok: 0, refused: 1, usage: 2, transport: 3, fault: 4 }',
    );
  });

  it('row 2 names the canonical-form refusal and both unwritable credential files', () => {
    const main = read(CLI_MAIN);
    expect(main).toContain('the body has no canonical form');
    // Both checks run before the request that issues the credential.
    const login = main.slice(main.indexOf('async function login('));
    expect(login.indexOf("assertWritable(tokenFile, 'the login token')")).toBeGreaterThan(0);
    expect(login.indexOf('assertWritable(tokenFile')).toBeLessThan(login.indexOf('signIn('));
    expect(main.indexOf('assertWritable(delegationFile')).toBeGreaterThan(0);
    expect(main.indexOf('assertWritable(delegationFile')).toBeLessThan(
      main.indexOf('cli.run(verb'),
    );
    expect(main).toContain('throw new UsageError(`cannot save ${what}');
    const row = exitRow(2);
    for (const phrase of [
      '`1e400`',
      '`task.pickup`',
      '`OPS_ASTRO_DELEGATION_FILE`',
      '`login`',
      '`OPS_ASTRO_TOKEN_FILE`',
    ]) {
      expect(row, phrase).toContain(phrase);
    }
    for (const name of ['OPS_ASTRO_DELEGATION_FILE', 'OPS_ASTRO_TOKEN_FILE']) {
      expect(main, name).toContain(`env['${name}']`);
    }
  });

  it('row 4 names every local save or removal that fails after the API answered', () => {
    for (const marker of [
      'cli: pickup applied but its credential could not be saved to',
      'cli: handback applied but its spent credential could not be removed from',
      'cli: login succeeded but its token could not be saved to',
      'cli: logout could not remove',
    ]) {
      expect(exitAfter(marker), marker).toBe('fault');
    }
    const row = exitRow(4);
    for (const phrase of ['`task.pickup`', '`task.handback`', '`login`', '`logout`']) {
      expect(row, phrase).toContain(phrase);
    }
  });
});

describe('CLI.md retries paragraph (R2-SURFACE-43, FR2-CLI-CONT)', () => {
  it('quotes the pickup stderr line and the handback replay', () => {
    const doc = folded(read(CLI_DOC));
    expect(read(CLI_MAIN)).toContain(
      '`cli: pickup applied but its credential could not be saved to ${delegationFile}: `',
    );
    expect(doc).toContain(
      '`cli: pickup applied but its credential could not be saved to <file>: <reason>`',
    );
    expect(doc).toMatch(/agent `task\.handback` that was applied but whose saved credential/u);
  });

  it('keeps the FR1 decision-exclusion sentence', () => {
    expect(folded(read(CLI_DOC))).toContain(
      'the API refuses `task.decide` with `DELEGATION_EXCLUDES_DECISION`',
    );
  });
});

const WEB_DOC = 'docs/local/WEB.md';

describe('WEB.md on the task page (R2-SURFACE-10, R2-THERMO-12, R2-SURFACE-41)', () => {
  it('names the unresolved and stale markers the comment box and propose form draw', () => {
    const doc = read(WEB_DOC);
    const markers: readonly [string, string][] = [
      ['apps/web/src/screens/task/Comments.tsx', 'data-comment="unresolved"'],
      ['apps/web/src/screens/task/Comments.tsx', 'data-comment="stale"'],
      ['apps/web/src/views/proposals.tsx', 'data-propose="unresolved"'],
      ['apps/web/src/views/proposals.tsx', 'data-propose="stale"'],
    ];
    for (const [file, marker] of markers) {
      expect(read(file), `${file} ${marker}`).toContain(marker);
      expect(doc, marker).toContain(`[${marker}]`);
    }
  });

  it('holds the unsent comment and proposal above the read, per task and grant', () => {
    const detail = read('apps/web/src/screens/TaskDetail.tsx');
    expect(detail).toContain('useHeld<CommentDraft>(identity, denied)');
    expect(detail).toContain('useHeld<ProposeDraft>(identity, denied)');
    expect(folded(read(WEB_DOC))).toContain(
      'An unsent comment or proposal is held above the task read, per task and grant',
    );
  });

  it('retries a details save under the same operationId while the draft is unchanged', () => {
    const detail = read('apps/web/src/screens/TaskDetail.tsx');
    expect(detail).toContain('held.generation === generation');
    expect(detail).toContain('operationId: attempt.operationId');
    expect(folded(read(WEB_DOC))).toContain(
      'A save of the title and due date whose answer never arrived is retried under the same `operationId`',
    );
  });
});

describe('WEB.md on the decision refusal and Start (R2-THERMO-12, R2-RUNTIME-14)', () => {
  it('quotes a refused decision under its gate whether or not it is the head', () => {
    const proposals = read('apps/web/src/views/proposals.tsx');
    // The quote is drawn by `Version`, not by the head-only `Decide`.
    expect(proposals).toContain(
      '{gate === null || props.note?.gateId !== gate.id ? null : <Refusal note={props.note} />}',
    );
    expect(proposals).toContain("return 'lineage'");
    expect(proposals).toContain("return 'section'");
    const doc = folded(read(WEB_DOC));
    expect(doc).toContain('whether or not that version is still the head');
    expect(doc).toMatch(/under its lineage, and failing that above the list/u);
    expect(doc).not.toMatch(/under the gate it was about, and only there/u);
  });

  it('does not claim Start is withheld on a completed task until the page wires it', () => {
    const detail = read('apps/web/src/screens/TaskDetail.tsx');
    const wired = /<Lifecycle[^>]*\bcompleted=/u.test(detail);
    if (!wired) {
      expect(folded(read(WEB_DOC))).not.toContain('Start is not offered on a completed task');
    }
  });
});

describe('WEB.md on the dock (R2-SURFACE-42)', () => {
  it('announces an open tab as Close and leaves its address for the board', () => {
    const shell = read('packages/ui/src/surfaces/Shell.tsx');
    expect(shell).toContain('aria-expanded={tab.open}');
    expect(shell).toContain("tab.open ? 'Close' : 'Open'");
    expect(read('apps/web/src/App.tsx')).toContain(
      "here === target ? pathTo('agency:projects-board') : target",
    );
    expect(folded(read(WEB_DOC))).toContain('An open dock tab is announced as "Close');
  });
});
