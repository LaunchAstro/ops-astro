// SPDX-License-Identifier: AGPL-3.0-only
//
// FR1-DBTEST #49: every database-bound suite is named in
// tests/db/named-suites.json, or is listed below as deliberately unnamed with
// the variable it waits for.
//
// The `local checks` job runs `pnpm test` with no DATABASE_URL, so a
// database-bound suite skips there and vitest exits 0. The `database
// conformance` job runs only the manifest's paths. A suite in neither place is
// run by no required context, and a regression in it merges green
// (docs/agents/database-conformance.md: "The manifest is the authority").
//
// A suite is taken as database-bound when it reaches the fresh-database harness
// through its relative imports, directly or through a harness such as
// world.ts. This one reaches no database and must not be named itself.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const HARNESS = 'packages/core-records/src/tenancy/testing/fresh-database.ts';

/**
 * Suites that reach the harness and stay out of the manifest, with the reason.
 * Some skip without a variable the runner does not set, and the runner refuses
 * a skip. The rest import a harness module for a pure part of it and open no
 * database, and the runner refuses a named suite that leaves the counter
 * alone. Each is also named in the manifest's comment, which is where
 * database-conformance.md says the reason is recorded.
 */
const NOT_NAMED: Readonly<Record<string, string>> = {
  'tests/api/server-onerror.test.ts': 'skips without SURFACE_API_PORT',
  'tests/cli/mounted-cli.test.ts': 'skips without SURFACE_API_PORT',
  'tests/acceptance/restart-and-expiry.test.ts': 'skips without L5_RESTART_CONTAINER_NAME',
  'tests/acceptance/restart-http.test.ts':
    'skips without L5_RESTART_CONTAINER_NAME and L5_RESTART_API_PORT',
  'tests/runtime/pickup-replay-restart.test.ts':
    'skips without PICKUP_REPLAY_API_PORT and PICKUP_REPLAY_PG_CONTAINER',
  'tests/acceptance/restart-declared.test.ts': 'pure: restart-harness refusals only',
  'tests/cli/cli-answers.test.ts': 'pure: the CLI against an HTTP stand-in',
  'tests/cli/cli-wire.test.ts': 'pure: the CLI against an HTTP stand-in',
  'tests/support/global-setup.test.ts': 'pure: besideUrl only',
};

interface Manifest {
  readonly comment: readonly string[];
  readonly invariant: readonly string[];
  readonly conformance: readonly string[];
}

const manifest = JSON.parse(
  readFileSync(join(root, 'tests/db/named-suites.json'), 'utf8'),
) as Manifest;

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(relative(root, path));
  }
  return out;
}

/** The same globs vitest.config.ts includes. */
const suites = ['tests', 'packages', 'apps']
  .flatMap((top) => walk(join(root, top)))
  .filter(
    (path) =>
      path.endsWith('.test.ts') || (path.startsWith('tests/') && path.endsWith('.test.tsx')),
  )
  .toSorted();

/** Relative value imports (not `import type`), resolved from the repository root. */
function importsOf(path: string): readonly string[] {
  const source = readFileSync(join(root, path), 'utf8');
  const found: string[] = [];
  for (const match of source.matchAll(
    /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gmu,
  )) {
    found.push(relative(root, resolve(root, dirname(path), match[1] ?? '')));
  }
  return found;
}

const bound = new Map<string, boolean>();
function reachesHarness(path: string, seen = new Set<string>()): boolean {
  if (path === HARNESS) return true;
  const known = bound.get(path);
  if (known !== undefined) return known;
  if (seen.has(path)) return false;
  seen.add(path);
  let result = false;
  try {
    result = importsOf(path).some((next) => reachesHarness(next, seen));
  } catch {
    result = false;
  }
  bound.set(path, result);
  return result;
}

const named = new Set([...manifest.invariant, ...manifest.conformance]);
const databaseBound = suites.filter((path) => reachesHarness(path));

describe('the named-suite manifest', () => {
  it('finds database-bound suites to check, so an empty scan cannot pass', () => {
    expect(databaseBound.length).toBeGreaterThan(named.size);
  });

  it('names every database-bound suite, or lists it as deliberately unnamed', () => {
    const unaccounted = databaseBound.filter(
      (path) => !named.has(path) && NOT_NAMED[path] === undefined,
    );
    expect(unaccounted).toStrictEqual([]);
  });

  it('records each deliberately unnamed suite in the manifest comment', () => {
    const comment = manifest.comment.join('\n');
    const unrecorded = Object.keys(NOT_NAMED).filter(
      (path) => !comment.includes(path.slice(path.lastIndexOf('/') + 1)),
    );
    expect(unrecorded).toStrictEqual([]);
  });

  it('lists as unnamed only suites that exist, reach a database and are not named', () => {
    for (const path of Object.keys(NOT_NAMED)) {
      expect(databaseBound, path).toContain(path);
      expect(named.has(path), path).toBe(false);
    }
  });

  it('names only suites that exist and reach a database', () => {
    const stray = [...named].filter((path) => !databaseBound.includes(path));
    expect(stray).toStrictEqual([]);
  });
});
