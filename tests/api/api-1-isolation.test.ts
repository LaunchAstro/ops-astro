// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, against the real boundary and a fresh Postgres: for every
// command in the catalogue, the CLI and the API answer a caller exactly as the
// app's own client does, so no surface reads a row, or skips a grant, the app
// refuses. Two businesses, Alpha and Bravo, and in Alpha two tasks standing for
// two clients' work, each with one person holding one grant on it alone.
// Made-up names only.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { buildCatalogue, type CatalogueRow } from '../../packages/core-wire/src/index.ts';
import { createCli } from '../../apps/cli/client.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { authorised, createApiFixture, post, tokenFor, type ApiFixture } from './fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Heard {
  readonly status: number;
  readonly code: unknown;
}

describe.skipIf(serverUrl === undefined)('API-1 isolation', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let rows: CatalogueRow[];
  const task: Record<'alpha' | 'client1' | 'client2' | 'bravo', string> = {
    alpha: '',
    client1: '',
    client2: '',
    bravo: '',
  };
  let clientOne: Member;
  let clientTwo: Member;

  const through = ((url: string | URL, init?: RequestInit) =>
    api.fetch(new Request(`http://api.test${String(url)}`, init))) as typeof fetch;

  async function create(businessKey: string, token: string): Promise<string> {
    const answer = await post(
      api,
      `/api/b/${businessKey}/task/create`,
      { operationId: randomUUID(), fields: { title: `made-up ${businessKey}` } },
      authorised(token),
    );
    const id = (answer.body as { recordId?: string }).recordId;
    if (answer.status !== 200 || typeof id !== 'string') throw new Error(JSON.stringify(answer));
    return id;
  }

  beforeAll(async () => {
    fixture = await createApiFixture('api_1_isolation');
    api = fixture.compose();
    rows = buildCatalogue([]);
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    const bravoWriter = await enrol(fixture.db.app, bravo, 'bravo-writer');
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoWriter, 'read');
      await grantTo(tx, bravoWriter, 'write');
    });
    const alphaToken = await tokenFor(fixture.member.presented.subject);
    task.client1 = await create('alpha', alphaToken);
    task.client2 = await create('alpha', alphaToken);
    task.bravo = await create('bravo', await tokenFor(bravoWriter.presented.subject));
    clientOne = await enrol(fixture.db.app, fixture.business, 'client-one-person');
    clientTwo = await enrol(fixture.db.app, fixture.business, 'client-two-person');
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await grantTo(tx, clientOne, 'read', { kind: 'record', id: task.client1 });
      await grantTo(tx, clientTwo, 'read', { kind: 'record', id: task.client2 });
    });
  }, 120_000);

  afterAll(async () => await fixture?.drop());

  /** One command through the app's client, the CLI and the API, as one caller. */
  async function threeWays(
    row: CatalogueRow,
    member: Member,
    businessKey: string,
    body: Record<string, unknown>,
  ): Promise<Heard[]> {
    const token = await tokenFor(member.presented.subject);
    const heard: Heard[] = [];
    const recording = (async (url: string | URL, init?: RequestInit) => {
      const response = await through(url, init);
      const parsed = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { code?: unknown };
      heard.push({ status: response.status, code: parsed.code });
      return response;
    }) as typeof fetch;
    const app = new OperationsClient({ origin: '', businessKey, token, fetch: recording });
    const operationId = randomUUID();
    await (row.kind === 'read'
      ? app.read(row.command as never, body)
      : app.mutate(row.command as never, body, { operationId, expectedRevision: 1 }));
    const payload = row.kind === 'read' ? body : { ...body, operationId, expectedRevision: 1 };
    const cli = createCli({
      businessKey,
      credential: token,
      transport: async (path, sent, credential) =>
        await recording(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
          body: sent,
        }),
    });
    await cli.run(row.command, payload);
    await recording(row.api.person.replace(':businessKey', businessKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    return heard;
  }

  it('API-1 isolation: business to business, every command answers the same refusal on every surface', async () => {
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await threeWays(row, fixture.member, 'bravo', { recordId: task.bravo });
      expect(heard, row.command).toHaveLength(3);
      expect(new Set(heard.map((one) => JSON.stringify(one))).size, row.command).toBe(1);
      expect(heard[0]?.status, row.command).toBeGreaterThanOrEqual(400);
    }
  });

  it('API-1 isolation: client to client, a grant on one task reads nothing of the other on any surface', async () => {
    const reads = rows.filter(
      (row) => row.kind === 'read' && row.command === ('task.read' as CommandName),
    );
    for (const [member, own, other] of [
      [clientOne, task.client1, task.client2],
      [clientTwo, task.client2, task.client1],
    ] as const) {
      for (const row of reads) {
        // eslint-disable-next-line no-await-in-loop -- each person in turn
        const allowed = await threeWays(row, member, 'alpha', { recordId: own });
        expect(allowed.map((one) => one.status)).toEqual([200, 200, 200]);
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
    }
  });
});
