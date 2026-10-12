// SPDX-License-Identifier: AGPL-3.0-only
//
// The protected set's verdicts are read from the verdict lines the same
// run's `db-conformance` printed, one per run item, and from nothing else. A
// suite is green only when each item the manifest and the shard plan expect
// of it has exactly one `ok` line; queue and delivery also needs the same
// run's restart leg. Each protected suite is one the real manifest names.

import { expect, it } from 'vitest';
import { PROTECTED, protectedVerdicts } from '../../scripts/local/journey-proofs.ts';
import { readNamedSuites } from '../../scripts/named-suites.ts';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const suites = PROTECTED.flatMap(([, files]) => files);
const ok = (item: string) => `db-conformance: verdict ok ${item}: 3 test(s) ran, moved 12`;
const failed = (item: string, why: string) => `db-conformance: verdict failed ${item}: ${why}`;
const SPLIT = 'tests/runtime/gate.test.ts';
const PARTS = [`${SPLIT}#1/2`, `${SPLIT}#2/2`];
/** What the journey hands the reader: the manifest, every expected item, the restart leg. */
const run = (restartLeg = true, items: readonly string[] = suites) => {
  const judged = { invariant: suites, conformance: [], items, restartLeg };
  return (lines: readonly string[]) => protectedVerdicts(lines.join('\n'), judged);
};
const status = (verdicts: ReturnType<ReturnType<typeof run>>, component: string) =>
  verdicts.find((verdict) => verdict.case === `protected: ${component}`);
const withParts = suites.flatMap((suite) => (suite === SPLIT ? PARTS : [suite]));

it('current-format verdicts pass every protected component', () => {
  const verdicts = run()(suites.map((item) => ok(item)));
  expect(verdicts.map(({ case: name, status: s }) => [name, s])).toStrictEqual([
    ['protected: domain model', 'pass'],
    ['protected: tenancy wrapper', 'pass'],
    ['protected: migrations', 'pass'],
    ['protected: gate engine', 'pass'],
    ['protected: queue and delivery', 'pass'],
  ]);
});

it('every PROTECTED suite is in the real manifest', () => {
  const manifest = readNamedSuites(root);
  const named = new Set([...(manifest.invariant ?? []), ...(manifest.conformance ?? [])]);
  expect(suites.filter((suite) => !named.has(suite))).toStrictEqual([]);
}, 30_000);

it('one failed part fails its suite', () => {
  const judge = run(true, withParts);
  expect(status(judge(withParts.map((item) => ok(item))), 'gate engine')?.status).toBe('pass');
  const lines = withParts.map((item) =>
    item === PARTS[1] ? failed(item, 'failed assertion') : ok(item),
  );
  const gate = status(judge(lines), 'gate engine');
  expect(gate?.status).toBe('fail');
  expect(gate?.detail).toContain(`${String(PARTS[1])}: failed assertion`);
});

it('queue and delivery is judged from its suites and the restart leg', () => {
  const queue = PROTECTED.find(([component]) => component === 'queue and delivery')?.[1] ?? [];
  expect(queue).toStrictEqual([
    'tests/db/inbox-conformance.test.ts',
    'tests/commands/inbox-restart.test.ts',
  ]);
  expect(status(run()(suites.map((item) => ok(item))), 'queue and delivery')?.status).toBe('pass');
  const lines = suites.map((item) =>
    item === queue[1] ? failed(item, 'vitest exited with status 1') : ok(item),
  );
  expect(status(run()(lines), 'queue and delivery')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('vitest exited with status 1'),
  });
  expect(status(run(false)(suites.map((item) => ok(item))), 'queue and delivery')).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining('restart leg'),
  });
});

it('a suite with part two missing is not green', () => {
  const judge = run(true, withParts);
  expect(status(judge(withParts.map((item) => ok(item))), 'gate engine')?.status).toBe('pass');
  const gate = status(
    judge(withParts.filter((item) => item !== PARTS[1]).map((item) => ok(item))),
    'gate engine',
  );
  expect(gate).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining(`${String(PARTS[1])}: no verdict in this run`),
  });
});

it('two verdicts for one item are not green', () => {
  expect(status(run()(suites.map((item) => ok(item))), 'gate engine')?.status).toBe('pass');
  const gate = status(run()([...suites.map((item) => ok(item)), ok(SPLIT)]), 'gate engine');
  expect(gate).toMatchObject({
    status: 'fail',
    detail: expect.stringContaining(`${SPLIT}: 2 verdicts in this run`),
  });
});
