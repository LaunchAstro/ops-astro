// SPDX-License-Identifier: AGPL-3.0-only
//
// CI-LOCAL (owner, 6 October 2026): the merge queue stops depending on GitHub's hosted runners.
// Behind the repository variable OPS_CI_LOCAL, a merge group's required jobs, and every job they
// wait on, run on our own Linux runners (labels `self-hosted`, `Linux`, `ops-merge-m5`);
// everything else stays on hosted runners, and with the variable unset nothing moves, so merging
// the routing changes no run until the switch. ops-astro is public, so a pull request, a fork's
// included, must never reach our runner (CIRUNNER): only `merge_group` routes. Job names do not
// change, so the required contexts still match. The workflows are read with a YAML parser and
// each `runs-on` is evaluated for every event and switch value (tests/ci/runs-on.ts), so a form a
// line pattern would misread is read as GitHub reads it.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { read, ROOT } from './merge-group-repo.ts';
import {
  behindRequired,
  evaluate,
  EVENTS,
  workflowEvents,
  HOSTED,
  LOCAL,
  labels,
  readJobs,
  routeProblems,
} from './runs-on.ts';

const WORKFLOWS = '.github/workflows';
const CI = `${WORKFLOWS}/ci.yml`;
const ROUTE =
  "${{ github.event_name == 'merge_group' && vars.OPS_CI_LOCAL == 'on' && fromJSON('[\"self-hosted\",\"Linux\",\"ops-merge-m5\"]') || 'ubuntu-latest' }}";
const GATE = `    name: contamination gate\n    runs-on: ${ROUTE}\n`;
const ROUTED = [
  'audit',
  'check',
  'commits',
  'database',
  'database-gate',
  'database-shard',
  'gate',
  'isolation',
  'isolation-tests',
  'licences',
  'local-checks',
  'pr-size',
  'secrets',
  'semgrep',
];

const files = () =>
  new Map(
    readdirSync(join(ROOT, WORKFLOWS))
      .filter((f) => /\.ya?ml$/u.test(f))
      .map((f) => [`${WORKFLOWS}/${f}`, read(`${WORKFLOWS}/${f}`)]),
  );

/** Each workflow from which no event can be read: a `%YAML 1.1` header reads `on` as `true`. */
const eventless = (texts: Map<string, string>) =>
  [...texts].filter(([f, t]) => workflowEvents(new Map([[f, t]])).size === 0).map(([f]) => f);

/** The workflows with each `[file, from, to]` swap made once; a swap that does not match fails. */
function planted(...swaps: [string, string, string][]) {
  const texts = files();
  for (const [file, from, to] of swaps) {
    const text = texts.get(file) ?? '';
    expect(text.split(from).length, `${file}: ${from}`).toBe(2);
    texts.set(file, text.replace(from, to));
  }
  return texts;
}
const gate = (runsOn: string): [string, string, string] => [
  CI,
  GATE,
  `    name: contamination gate\n    runs-on: ${runsOn}\n`,
];
const hosted = (l: unknown) => Array.isArray(l) && l.length === 1 && HOSTED.has(String(l[0]));
const labelsAs = (form: string) => `fromJSON('${form}')`;
const routeWith = (condition: string) =>
  `\${{ ${condition} && ${labelsAs('["self-hosted","Linux","ops-merge-m5"]')} || 'ubuntu-latest' }}`;
/** Every event the route is evaluated on but merge_group, excluded one by one. */
const DENYLIST = EVENTS.filter((e) => e !== 'merge_group' && e !== 'an_unlisted_event')
  .map((e) => `github.event_name != '${e}'`)
  .join(' && ');

// Each form a change could take that sends a pull request, a fork's included, to the M5, or
// leaves the queue on hosted runners.
const PLANTS: [string, [string, string, string][], string][] = [
  [
    'a route without the event check',
    [gate(routeWith("vars.OPS_CI_LOCAL == 'on'"))],
    'contamination gate: reaches the M5 on pull_request,',
  ],
  [
    'a route on every event but a pull request',
    [gate(routeWith("github.event_name != 'pull_request' && vars.OPS_CI_LOCAL == 'on'"))],
    'contamination gate: reaches the M5 on pull_request_target',
  ],
  [
    'a switch read as "not off"',
    [gate(routeWith("github.event_name == 'merge_group' && vars.OPS_CI_LOCAL != 'off'"))],
    'contamination gate: reaches the M5 on merge_group, OPS_CI_LOCAL=undefined',
  ],
  [
    'a route on every event but the ones listed',
    [gate(routeWith(`${DENYLIST} && vars.OPS_CI_LOCAL == 'on'`))],
    'contamination gate: reaches the M5 on an_unlisted_event,',
  ],
  [
    'a comparison of an empty string with null',
    [gate(routeWith("'' == null"))],
    'compares a non-string',
  ],
  [
    'a number read as truthy where GitHub reads it as false',
    [gate(routeWith("!fromJSON('0')"))],
    'contamination gate: reaches the M5 on pull_request,',
  ],
  [
    'a comparison of two arrays',
    [gate(routeWith("fromJSON('[]') != fromJSON('[]')"))],
    'compares a non-string',
  ],
  [
    'the labels without Linux',
    [gate(ROUTE.replace('"Linux",', ''))],
    'asks for self-hosted,ops-merge-m5',
  ],
  [
    'a route reading a value a pull request sets',
    [gate(routeWith("github.head_ref == 'x'"))],
    'reads github.head_ref',
  ],
  [
    'a function the route does not use',
    [gate("${{ contains(github.event_name, 'merge') && 'ops-merge-m5' || 'ubuntu-latest' }}")],
    'reads contains',
  ],
  [
    'the M5 named outright as a block list',
    [gate('\n      - self-hosted\n      - Linux\n      - ops-merge-m5')],
    'contamination gate: reaches the M5 on pull_request',
  ],
  ['the M5 named outright as a label', [gate('ops-merge-m5')], 'asks for ops-merge-m5'],
  [
    'a runner group by name',
    [gate('{ group: ops-merge-m5, labels: [self-hosted] }')],
    'runs-on unread',
  ],
  [
    'a label one character off',
    [gate(ROUTE.replace('merge-m5"', 'merge-m6"'))],
    'asks for self-hosted,Linux,ops-merge-m6',
  ],
  [
    'an expression inside a longer string',
    [gate('self-hosted-${{ vars.OPS_CI_LOCAL }}')],
    'a partial expression',
  ],
  [
    'a required job left on hosted runners',
    [gate('ubuntu-latest')],
    'contamination gate: stays hosted on merge_group, OPS_CI_LOCAL="on"',
  ],
  [
    'a job a required check waits on left on hosted runners',
    [
      [
        CI,
        `    if: github.event_name != 'pull_request'\n    runs-on: ${ROUTE}\n`,
        `    if: github.event_name != 'pull_request'\n    runs-on: ubuntu-latest\n`,
      ],
    ],
    'database conformance shard ${{ matrix.shard }}: stays hosted',
  ],
  [
    'a job outside the required set sent to the M5',
    [
      [
        CI,
        '    name: command parity\n    needs: [gate]\n    runs-on: ubuntu-latest\n',
        `    name: command parity\n    needs: [gate]\n    runs-on: ${ROUTE}\n`,
      ],
    ],
    'command parity: reaches the M5 on merge_group',
  ],
  [
    'the route in a workflow behind no required check',
    [
      [
        `${WORKFLOWS}/structural.yml`,
        "    if: github.event_name != 'push'\n    runs-on: ubuntu-latest\n",
        `    if: github.event_name != 'push'\n    runs-on: ${ROUTE}\n`,
      ],
    ],
    'structural checks (vs current main): reaches the M5 on merge_group',
  ],
  [
    'a renamed required job',
    [[CI, '    name: contamination gate\n', '    name: contamination gate (local)\n']],
    "no job reports the required check 'contamination gate'",
  ],
];

describe('merge group: the M5 takes the merge queue alone, behind OPS_CI_LOCAL', () => {
  it('routes every job behind a required check, and nothing else, and only a merge group', () => {
    expect(routeProblems(files())).toStrictEqual([]);
  });

  it('tries every event any workflow here starts on, and one none does', () => {
    const missing = [...workflowEvents(files())].filter((e) => !EVENTS.includes(e));
    expect(missing).toStrictEqual([]);
    expect(EVENTS).toContain('an_unlisted_event');
  });

  it('reads at least one event from every workflow, so none hides its triggers', () => {
    expect(eventless(files())).toStrictEqual([]);
    const hidden = planted([
      `${WORKFLOWS}/structural.yml`,
      'name: structural\n',
      '%YAML 1.1\n---\nname: structural\n',
    ]);
    expect(eventless(hidden)).toStrictEqual([`${WORKFLOWS}/structural.yml`]);
  });

  it('keeps every run on hosted runners while OPS_CI_LOCAL is unset', () => {
    const { jobs } = readJobs(files());
    expect(jobs.length).toBeGreaterThan(0);
    const moved = jobs.flatMap((job) =>
      EVENTS.map((event) => [job.name, event, labels(job.runsOn, { event, on: undefined })]),
    );
    expect(moved.filter(([, , l]) => !hosted(l))).toStrictEqual([]);
  });

  it('names the routed jobs: the required checks, their shards and the gate', () => {
    const { jobs } = readJobs(files());
    const want = ROUTED.map((id) => `${CI} ${id}`).concat(
      `${WORKFLOWS}/review-evidence.yml review-evidence`,
    );
    expect([...behindRequired(jobs)].toSorted()).toStrictEqual(want.toSorted());
  });

  it.each(PLANTS)('refuses %s', (_form, swaps, reason) => {
    expect(routeProblems(planted(...swaps)).join('\n')).toContain(reason);
  });

  it('refuses a duplicate key and a workflow it cannot parse', () => {
    const doubled = planted([CI, GATE, `${GATE}    runs-on: ubuntu-latest\n`]);
    expect(routeProblems(doubled)).not.toStrictEqual([]);
    expect(routeProblems(new Map([[CI, 'jobs: [']]))).not.toStrictEqual([]);
  });

  it('reads the expression as GitHub does', () => {
    const route = ROUTE.slice(3, -2);
    const push = { event: 'push', on: undefined };
    expect(evaluate(route, { event: 'merge_group', on: 'On' })).toStrictEqual(LOCAL);
    expect(evaluate(route, { event: 'MERGE_GROUP', on: 'on' })).toStrictEqual(LOCAL);
    expect(evaluate(route, { event: 'merge_group', on: 'yes' })).toBe('ubuntu-latest');
    expect(evaluate(route, { event: 'pull_request', on: 'on' })).toBe('ubuntu-latest');
    expect(evaluate("'' || null && 'x'", push)).toBeNull();
    expect(evaluate("!(null) && 'it''s'", push)).toBe("it's");
    expect(() => evaluate("'a' 'b'", push)).toThrow('unread tail');
  });
});
