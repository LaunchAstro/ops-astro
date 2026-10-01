// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one scripted run over two backends */
//
// API-5's conformance run (#633): the wayfinding operations the upstream
// skills send (chart, file tickets, block, read the frontier, claim, resolve,
// graduate fog), scripted once and run against two backends: the upstream
// local-Markdown tracker and Ops Astro through its tracker file's CLI lines.
// The frontier after every step and the map each ends with must agree, and
// match what the skill expects. The GitHub backend is not driven here: it is
// a live outside service (see the slice handback).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cliWorld, type CliWorld } from './api-3-world.ts';
import { localBackend, opsAstroBackend, type Backend, type Outcome } from './tracker-backends.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Run {
  readonly frontiers: readonly (readonly string[])[];
  readonly outcome: Outcome;
}

/** The script: every step a skill session takes while charting and working a map. */
async function script(tracker: Backend): Promise<Run> {
  const frontiers: (readonly string[])[] = [];
  await tracker.chart('conformance map', 'a way to import refunds', 'import domain', [
    'how refunds reconcile',
    'who signs off',
  ]);
  const a = await tracker.ticket({ title: 'which export has refunds', type: 'research' });
  const b = await tracker.ticket({ title: 'agree the refund mapping', type: 'grilling' });
  const c = await tracker.ticket({ title: 'get a sample export', type: 'task' });
  // Create, then wire: the second pass.
  await tracker.block(b, [a]);
  frontiers.push(await tracker.frontier());
  await tracker.claim(a);
  frontiers.push(await tracker.frontier());
  await tracker.resolve(a, 'The monthly export carries refunds.', 'monthly export has refunds');
  frontiers.push(await tracker.frontier());
  await tracker.graduate('how refunds reconcile', [
    { title: 'match refunds to invoices', type: 'research' },
  ]);
  frontiers.push(await tracker.frontier());
  await tracker.claim(c);
  await tracker.resolve(c, 'Saved to the shared folder.', 'sample in the shared folder');
  frontiers.push(await tracker.frontier());
  return { frontiers, outcome: await tracker.outcome() };
}

const EXPECTED: Run = {
  frontiers: [
    ['which export has refunds', 'get a sample export'],
    ['get a sample export'],
    ['agree the refund mapping', 'get a sample export'],
    ['agree the refund mapping', 'get a sample export', 'match refunds to invoices'],
    ['agree the refund mapping', 'match refunds to invoices'],
  ],
  outcome: {
    destination: 'a way to import refunds',
    notes: 'import domain',
    fog: ['who signs off'],
    decisions: [
      'which export has refunds: monthly export has refunds',
      'get a sample export: sample in the shared folder',
    ],
    open: ['agree the refund mapping', 'match refunds to invoices'],
    resolved: ['which export has refunds', 'get a sample export'],
  },
};

describe.skipIf(serverUrl === undefined)('API-5 conformance run', () => {
  let w: CliWorld;
  let scratch = '';

  beforeAll(async () => {
    w = await cliWorld('api5conf', 'api5conf');
    scratch = mkdtempSync(join(tmpdir(), 'api5-local-'));
  }, 180_000);

  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await w?.drop();
  });

  it('API-5 the conformance run charts, claims, resolves and graduates fog on a fixture map against both backends and the outcomes agree', async () => {
    const local = await script(localBackend(scratch));
    const lead = await w.member('lead', ['read', 'write', 'assign', 'comment', 'decide']);
    const ops = await script(opsAstroBackend(await w.person(lead)));
    // Each against what the skill expects, so two backends wrong the same way still fail.
    expect(local).toStrictEqual(EXPECTED);
    expect(ops).toStrictEqual(EXPECTED);
    expect(ops).toStrictEqual(local);
  });
});
