// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, against the real boundary and a fresh Postgres: for every
// command in the catalogue, the CLI and the API answer a caller exactly as the
// app's own client does, so no surface reads a row, or skips a grant, the app
// refuses. Two businesses, Alpha and Bravo, and in Alpha two tasks standing for
// two clients' work, each with one person holding one grant on it alone; and
// an agent working under a live delegation from another person, which reaches
// only the task it picked up, never a second Alpha person's own held reservation
// or live lease. Made-up names only.
//
// The world (businesses, people, the delegation and its claims) is set up in
// api-1-isolation-world.ts; the three surfaces and the leak check are in
// api-1-isolation-surfaces.ts; the delegation crossing's proofs are in
// api-1-isolation-delegation.ts.

import { describe, expect, it, vi } from 'vitest';
import type { CatalogueRow } from '../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  api,
  bravoBusinessId,
  clientOne,
  clientTwo,
  fixture,
  label,
  rows,
  task,
  useIsolationWorld,
} from './api-1-isolation-world.ts';
import { delegationCrossing, delegationCrossingTargets } from './api-1-isolation-delegation.ts';
import { foreign, threeWays, type Heard } from './api-1-isolation-surfaces.ts';

const serverUrl = databaseUrlFromEnvironment();

it('a refusal carrying another client record is detected', () => {
  const refused: Heard[] = [
    { status: 403, code: 'SCOPE_NOT_GRANTED', body: { recordId: '<client2 task>' } },
  ];
  expect(foreign(refused, 'client1')).toEqual(['client2']);
});

describe.skipIf(serverUrl === undefined)('API-1 isolation', () => {
  useIsolationWorld();
  businessAndClientCrossings();
  delegationCrossing();
  delegationCrossingTargets();
  leaksInSuccessfulReads();
  refusalsNameNoForeignRecord();
});

function businessAndClientCrossings(): void {
  it('API-1 isolation: business to business, every command answers the same refusal on every surface', async () => {
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await threeWays(row, fixture.member, 'bravo', { recordId: task.bravo });
      expect(heard, row.command).toHaveLength(3);
      expect(new Set(heard.map((one) => JSON.stringify(one))).size, row.command).toBe(1);
      expect(heard[0]?.status, row.command).toBeGreaterThanOrEqual(400);
      expect(foreign(heard, null), row.command).toEqual([]);
    }
  }, 60_000);

  it('API-1 isolation: client to client, a grant on one task reads nothing of the other on any surface', async () => {
    const reads = rows.filter(
      (row) => row.kind === 'read' && row.command === ('task.read' as CommandName),
    );
    for (const [member, own, other, name] of [
      [clientOne, task.client1, task.client2, 'client1'],
      [clientTwo, task.client2, task.client1, 'client2'],
    ] as const) {
      for (const row of reads) {
        // eslint-disable-next-line no-await-in-loop -- each person in turn
        const allowed = await threeWays(row, member, 'alpha', { recordId: own });
        expect(allowed.map((one) => one.status)).toEqual([200, 200, 200]);
        expect(new Set(allowed.map((one) => JSON.stringify(one))).size).toBe(1);
        expect(JSON.stringify(allowed[0]?.body)).toContain(`<${name} task>`);
        expect(foreign(allowed, name)).toEqual([]);
        // eslint-disable-next-line no-await-in-loop -- each person in turn
        const refused = await threeWays(row, member, 'alpha', { recordId: other });
        expect(new Set(refused.map((one) => JSON.stringify(one))).size).toBe(1);
        expect(refused[0]?.status).toBeGreaterThanOrEqual(400);
      }
    }
    // And every write, as the person holding read alone on their own task: refused alike everywhere.
    for (const row of rows.filter((one) => one.kind === 'write')) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client2 });
      expect(new Set(heard.map((one) => JSON.stringify(one))).size, row.command).toBe(1);
      expect(heard[0]?.status, row.command).toBeGreaterThanOrEqual(400);
      expect(foreign(heard, 'client1'), row.command).toEqual([]);
    }
  }, 60_000);
}

function leaksInSuccessfulReads(): void {
  it('API-1 isolation: a successful read carrying the other client record is caught', async () => {
    const row = rows.find((one) => one.command === 'task.read') as CatalogueRow;
    const leaked = vi
      .spyOn(api, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(Response.json({ recordId: task.client2, fields: { title: 'x' } })),
      );
    try {
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client1 });
      expect(heard.map((one) => one.status)).toEqual([200, 200, 200]);
      expect(foreign(heard, 'client1')).toEqual(['client2']);
    } finally {
      leaked.mockRestore();
    }
  });
}

function refusalsNameNoForeignRecord(): void {
  it('refusals expose no foreign business or person record', () => {
    const heard: Heard[] = [
      {
        status: 403,
        code: 'SCOPE_NOT_GRANTED',
        body: label({ businessId: bravoBusinessId, personId: clientTwo.personId }),
      },
    ];
    expect(foreign(heard, 'client1')).toEqual(['bravo', 'client2']);
  });
}
