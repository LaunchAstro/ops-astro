// SPDX-License-Identifier: AGPL-3.0-only
//
// The scheduled sweep entry (`apps/automations/sweep.ts`) is a process launchd
// starts on the environment machine, and nothing a person or an agent sends
// reaches it. The sweep's round is called from the API process's sweeper, the
// API process and this entry alone; no product file imports the entry; and no
// route, command-line verb or command catalogue entry names it.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VERB_TABLE } from '../../apps/cli/verbs.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { sourcesUnder, SWEEP_CALLERS } from './run-start-scan.ts';

const ENTRY = 'apps/automations/sweep.ts';
const ROUND = /\b(?:occurrenceRound|startOccurrenceSweeper|sweepOccurrences)\b/u;
/** What would name the entry: its function, its script or its folder. */
const NAMES_IT = /\bsweepEntry\b|automations:sweep|apps\/automations|\.\.\/automations\//u;

/**
 * Source text without its comments. The scan's `codeOf` also drops strings,
 * which a regular expression holding a quote can run past, so it is not used.
 */
const uncommented = (path: string): string =>
  readFileSync(path, 'utf8').replaceAll(/\/\*[\s\S]*?\*\/|(?<![:'"`])\/\/.*$/gmu, '');

const product = (): string[] =>
  ['apps', 'packages', 'scripts'].flatMap((root) => sourcesUnder(root));

/** Every module `path` imports, relative ones resolved from the repository root. */
function importsOf(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  return [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/gu)].map(([, target]) =>
    target?.startsWith('.') === true ? normalize(join(dirname(path), target)) : (target ?? ''),
  );
}

/** Control: a scan for the entry's name means something only while the entry is there. */
const entryIsThere = (): void => {
  expect(existsSync(ENTRY), `${ENTRY} is the scheduled entry`).toBe(true);
};

describe('the scheduled entry is not a route', () => {
  it('the sweep round is called from the API sweeper, the API process and the scheduled entry alone', () => {
    const callers = [...sourcesUnder('apps'), ...sourcesUnder('scripts')].filter((path) =>
      ROUND.test(uncommented(path)),
    );
    expect(callers.toSorted()).toEqual([...SWEEP_CALLERS].toSorted());
  });

  it('no file under apps, packages or scripts imports the scheduled entry but its own', () => {
    entryIsThere();
    const importers = product()
      .filter((path) => !path.startsWith('apps/automations/'))
      .filter((path) => importsOf(path).some((target) => target.includes('apps/automations/')));
    expect(importers).toEqual([]);
  });

  it('no route, command-line verb or catalogue entry names it', () => {
    entryIsThere();
    const routes = product().filter(
      (path) => path !== ENTRY && NAMES_IT.test(readFileSync(path, 'utf8')),
    );
    expect(routes).toEqual([]);
    expect(VERB_TABLE.filter((row) => /sweep/iu.test(`${row.verb} ${row.command}`))).toEqual([]);
    expect(COMMAND_SURFACE.filter((command) => /sweep/iu.test(command.name))).toEqual([]);
  });
});
