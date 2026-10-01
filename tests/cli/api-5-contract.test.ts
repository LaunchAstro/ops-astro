// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-await-in-loop, max-lines-per-function -- documented calls run in order; one case per checklist line */
//
// API-5's contract lines (#633), read from the files themselves: the Ops
// Astro tracker file names every operation the upstream tracker contract
// names, each one CLI call that the verb CLI turns into its owning command;
// its mapping table is the spec's, line for line; the upstream skill files
// are unmodified at their pinned digests; the research artefact answers "not
// available until Docs" and sends nothing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVerbCli } from '../../apps/cli/verbs.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { COMMAND_SURFACE, pathOf } from '../../packages/core-wire/src/index.ts';
import {
  cliCalls,
  firstDifference,
  operations,
  read,
  ROOT,
  section,
  sha256,
  SPEC_SNAPSHOT,
  tableRows,
  TRACKER_FILE,
  UPSTREAM,
  words,
} from './api-5-tracker.ts';

const ID = '11111111-2222-4333-8444-555555555555';

/** Each upstream operation, the owning command its one Ops Astro call must reach. */
const UPSTREAM_OPERATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Conventions: {
    'Create an issue': 'task.create',
    'Read an issue': 'task.read',
    'List issues': 'task.board',
    'Comment on an issue': 'task.comment',
    'Apply / remove labels': 'task.set_type',
    Close: 'task.complete',
  },
  'Wayfinding operations': {
    Map: 'map.chart',
    'Child ticket': 'task.create',
    Blocking: 'task.set_blocking',
    'Frontier query': 'map.frontier',
    Claim: 'task.claim',
    Resolve: 'task.resolve',
  },
};

/** The documented line as a runnable argv: placeholders become an id, `n` a revision. */
function argvOf(call: string): readonly string[] {
  const argv = words(call.replaceAll(/<[^>]+>/gu, ID)).slice(2);
  return argv.map((word, at) => (word === 'n' && argv[at - 1] === '--revision' ? '3' : word));
}

/** Run one documented call through the real verb CLI; the transport records where it went. */
async function dispatch(call: string): Promise<{ readonly exit: number; readonly sent: string[] }> {
  const sent: string[] = [];
  const transport: Transport = (path) => {
    const command = COMMAND_SURFACE.find((row) => path.endsWith(pathOf(row.name)));
    sent.push(command?.name ?? path);
    const body = JSON.stringify({ ok: true, recordId: ID, revision: 4, detail: {} });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  const cli = createVerbCli({ transport, businessKey: 'b', credential: 'c', entry: 'person' });
  const answer = await cli.run(argvOf(call));
  return { exit: answer.exit, sent };
}

describe('API-5 the tracker file', () => {
  it('API-5 every operation the upstream tracker contract names has its Ops Astro entry, one CLI call each', async () => {
    expect(existsSync(join(ROOT, TRACKER_FILE)), TRACKER_FILE).toBe(true);
    const ours = read(TRACKER_FILE);
    const github = read(`${UPSTREAM}/issue-tracker-github.md`);
    const local = read(`${UPSTREAM}/issue-tracker-local.md`);
    for (const [heading, expected] of Object.entries(UPSTREAM_OPERATIONS)) {
      // The contract is upstream's: every label it names under this heading.
      const upstream = operations(section(github, heading)).map((one) => one.label);
      expect(upstream.toSorted(), heading).toStrictEqual(Object.keys(expected).toSorted());
      const entries = operations(section(ours, heading));
      for (const [label, command] of Object.entries(expected)) {
        const entry = entries.find((one) => one.label === label);
        expect(entry, `${heading}: ${label}`).toBeDefined();
        const calls = cliCalls(entry?.text ?? '');
        expect(calls, `${label}: one CLI call`).toHaveLength(1);
        const ran = await dispatch(calls[0] as string);
        expect(ran, `${label}: ${calls[0] ?? ''}`).toStrictEqual({ exit: 0, sent: [command] });
      }
    }
    // The local tracker names the same wayfinding operations ("Frontier" for "Frontier query").
    const ourLabels = operations(section(ours, 'Wayfinding operations')).map((one) => one.label);
    for (const label of operations(section(local, 'Wayfinding operations')).map((o) => o.label))
      expect(
        ourLabels.some((one) => one.startsWith(label)),
        label,
      ).toBe(true);
    // Every other operation it documents is one call the CLI runs, too.
    for (const heading of ['Conventions', 'Wayfinding operations']) {
      for (const entry of operations(section(ours, heading))) {
        const calls = cliCalls(entry.text);
        expect(calls, `${entry.label}: one CLI call`).toHaveLength(1);
        const ran = await dispatch(calls[0] as string);
        const unavailable = entry.label === 'Research artifact';
        expect(ran.exit, `${entry.label}: ${calls[0] ?? ''}`).toBe(unavailable ? 1 : 0);
        expect(ran.sent, entry.label).toHaveLength(unavailable ? 0 : 1);
      }
    }
    for (const heading of [
      'When a skill says "publish to the issue tracker"',
      'When a skill says "fetch the relevant ticket"',
    ]) {
      const calls = cliCalls(section(ours, heading));
      expect(calls, heading).toHaveLength(1);
      expect((await dispatch(calls[0] as string)).exit, heading).toBe(0);
    }
  });

  it('API-5 the mapping table in the spec matches the tracker file line for line; a test fails when they differ', () => {
    const spec = tableRows(read(SPEC_SNAPSHOT));
    const ours = tableRows(section(read(TRACKER_FILE), 'The mapping table'));
    expect(spec.length).toBeGreaterThan(10);
    expect(firstDifference(spec, ours)).toBeNull();
    // The comparison is line for line: one changed cell, a dropped row or an
    // added one is caught, and the line is named.
    const changed = ours.map((row, at) => (at === 3 ? `${row}!` : row));
    expect(firstDifference(spec, changed)?.line).toBe(4);
    expect(firstDifference(spec, ours.slice(0, -1))?.right).toBe('(none)');
    expect(firstDifference(spec, [...ours, '| extra |'])?.left).toBe('(none)');
    // Against the spec itself, where a roadmap checkout is named.
    const roadmap = process.env['OPS_ASTRO_ROADMAP'];
    if (roadmap !== undefined && roadmap !== '') {
      const source = readFileSync(join(roadmap, 'docs/design-system/CAPABILITY-SLICES.md'), 'utf8');
      const table = source.slice(source.indexOf('**The one mapping table**'));
      expect(firstDifference(tableRows(table), spec)).toBeNull();
    }
  });

  it('API-5 the upstream skill files are not modified; their pinned digest is recorded', () => {
    const pins = tableRows(section(read(TRACKER_FILE), 'Pinned upstream files')).slice(1);
    const pinned = new Map(pins.map((row) => row.split(' | ') as [string, string]));
    const required = [
      '.claude/skills/wayfinder/SKILL.md',
      '.claude/skills/grilling/SKILL.md',
      `${UPSTREAM}/issue-tracker-github.md`,
      `${UPSTREAM}/issue-tracker-local.md`,
    ];
    for (const path of required) {
      const pin = pinned.get(`\`${path}\``);
      expect(pin, path).toMatch(/^`[0-9a-f]{64}`$/u);
      expect(sha256(path), path).toBe(pin?.slice(1, -1));
    }
    // The lock still names them from the upstream source.
    const lock = JSON.parse(read('skills-lock.json')) as {
      skills: Record<string, { source: string }>;
    };
    for (const skill of ['wayfinder', 'grilling', 'setup-matt-pocock-skills'])
      expect(lock.skills[skill]?.source, skill).toBe('mattpocock/skills');
  });

  it('API-5 every operation except the research artefact runs in phase 2; the research artefact answers "not available until Docs" with no fallback store', async () => {
    const ours = read(TRACKER_FILE);
    const entry = operations(section(ours, 'Wayfinding operations')).find(
      (one) => one.label === 'Research artifact',
    );
    const calls = cliCalls(entry?.text ?? '');
    expect(calls).toHaveLength(1);
    const sent: string[] = [];
    const transport: Transport = (path) => {
      sent.push(path);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const cli = createVerbCli({ transport, businessKey: 'b', credential: 'c', entry: 'person' });
    const answer = await cli.run(argvOf(calls[0] as string));
    expect(answer.exit).toBe(1);
    expect(answer.out).toContain('not available until Docs');
    // Nothing sent is nothing stored: there is no fallback store.
    expect(sent).toHaveLength(0);
  });
});
