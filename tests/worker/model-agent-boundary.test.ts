// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent holds no database. It runs on the owner's machine beside
// Ollama and connects out to Realtime only, so neither its entry nor the one
// custody entry it may take (`packages/core-custody/src/agent.ts`) reaches a
// records, runtime or command module, the API, a Postgres driver or text
// naming `DATABASE_URL`. The walk is checked against custody's own index,
// which does reach the database, so a walk that saw nothing would go red.
// The cruiser rules that hold the same line in CI are planted against here.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cruise, importGraph, ROOT } from '../support/import-graph.ts';

const AGENT_ENTRY = 'apps/model-agent/main.ts';
const CUSTODY_ENTRY = 'packages/core-custody/src/agent.ts';

/** What of a graph would hold or reach a database. */
function databaseIn(entry: string): readonly string[] {
  const { files, packages } = importGraph(entry);
  return [
    ...[...files].filter((file) =>
      /^(packages\/core-(records|runtime|commands)\/|apps\/api\/)/u.test(file),
    ),
    ...[...packages].filter((name) => /^(postgres|pg)(\/|$)/u.test(name)),
    ...[...files].filter((file) => readFileSync(join(ROOT, file), 'utf8').includes('DATABASE_URL')),
  ];
}

describe('the model agent holds no database', () => {
  it('its entry exists and is its own process entry', () => {
    expect(existsSync(join(ROOT, AGENT_ENTRY))).toBe(true);
    expect(readFileSync(join(ROOT, AGENT_ENTRY), 'utf8')).toMatch(/import\.meta\.main/u);
  });

  it('custody’s agent entry reaches no database module, driver or DATABASE_URL', () => {
    expect(databaseIn(CUSTODY_ENTRY)).toStrictEqual([]);
  });

  it('the agent’s whole graph reaches none either, and takes custody only by that entry', () => {
    expect(databaseIn(AGENT_ENTRY)).toStrictEqual([]);
    const { files } = importGraph(AGENT_ENTRY);
    expect(files.has(CUSTODY_ENTRY)).toBe(true);
    expect(files.has('packages/core-custody/src/index.ts')).toBe(false);
  });

  it('control: the walk finds the database behind custody’s own index', () => {
    expect(databaseIn('packages/core-custody/src/index.ts').length).toBeGreaterThan(0);
  });
});

describe('the cruiser rules fire', () => {
  const custody = {
    // The cruise takes every configured target; the test tree needs a file.
    'tests/support/declining-reporter.ts': 'export const R = { observe: () => null };\n',
    [CUSTODY_ENTRY]: 'export const sealed = 1;\n',
    'packages/core-custody/src/carriage.ts': 'export const carriage = 1;\n',
    'packages/core-custody/src/index.ts': 'export const index = 1;\n',
    'packages/core-records/src/index.ts': 'export const records = 1;\n',
  };

  it('is green when the agent takes custody by its agent entry', () => {
    const answer = cruise({
      ...custody,
      [AGENT_ENTRY]:
        "import { sealed } from '../../packages/core-custody/src/agent.ts';\nsealed;\n",
    });
    expect(answer.output).toContain('the structural rules hold');
    expect(answer.status).toBe(0);
  });

  it('is red when an app reaches past that entry into custody', () => {
    const answer = cruise({
      ...custody,
      [AGENT_ENTRY]:
        "import { carriage } from '../../packages/core-custody/src/carriage.ts';\ncarriage;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('index-only');
  });

  it('is red when the agent imports a database package', () => {
    const answer = cruise({
      ...custody,
      [AGENT_ENTRY]:
        "import { records } from '../../packages/core-records/src/index.ts';\nrecords;\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('worker-holds-no-database');
  });

  it('is red when custody’s agent entry imports a database package', () => {
    const answer = cruise({
      ...custody,
      [CUSTODY_ENTRY]: "export { records } from '../../core-records/src/index.ts';\n",
    });
    expect(answer.status).toBe(1);
    expect(answer.output).toContain('worker-holds-no-database');
  });
});
