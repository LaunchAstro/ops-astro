// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite per ticket: one case on one composed API */
//
// `WF-7 CLI parity`: the research run's agent resolves its ticket through the
// generated client on the agent prefix, with its own login and the delegation
// its pickup minted, and gets what the agent envelope gives: the ticket
// resolved, and for another ticket the same refusal, code and names.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createCli, type CliAnswer } from '../../apps/cli/client.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { createApiFixture, BUSINESS_KEY, tokenFor, type ApiFixture } from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Body = Readonly<Record<string, unknown>>;

describe.skipIf(serverUrl === undefined)('WF-7 from the command line', () => {
  let fixture: ApiFixture;
  let api: Hono;

  const detailOf = (answer: unknown): Body => {
    const detail = (answer as { detail?: Body }).detail;
    if (detail === undefined) throw new Error(JSON.stringify(answer));
    return detail;
  };
  const asPerson = async (body: Body) =>
    await executeCommand(fixture.db.app, fixture.business, fixture.member.presented, 'api', {
      operationId: randomUUID(),
      ...body,
    } as never);
  const asAgent = async (body: Body, credential?: string) =>
    await executeAgentCommand(fixture.db.app, fixture.business, fixture.agent, credential, {
      operationId: randomUUID(),
      ...body,
    } as never);
  const revisionOf = async (recordId: string): Promise<number> =>
    (
      await fixture.db.admin.execute<{ readonly revision: number }>(
        'select revision::int as revision from public.records where business_id = $1 and id = $2',
        [fixture.business, recordId],
      )
    )[0]?.revision ?? 0;
  const created = async (title: string): Promise<string> =>
    String(
      ((await asPerson({ command: 'task.create', fields: { title } })) as { recordId: string })
        .recordId,
    );

  /** A research ticket the member approved and the agent picked up, and its credential. */
  const pickedResearch = async (): Promise<{ ticket: string; delegation: string }> => {
    const ticket = await created('wf7 cli research');
    const proposed = detailOf(
      await asPerson({
        command: 'task.propose',
        recordId: ticket,
        expectedRevision: await revisionOf(ticket),
        purpose: `draft_${randomUUID().slice(0, 8)}`,
        maximumMinor: 3_000,
        currency: 'AUD',
        payload: { instruction: 'research it' },
        step: { kind: 'compose', payload: {} },
      }),
    );
    const decided = detailOf(
      await asPerson({
        command: 'task.decide',
        gateId: proposed['gateId'],
        versionId: proposed['versionId'],
        decision: 'approve',
        note: 'approved so the run can work it',
      }),
    );
    const picked = detailOf(
      await asAgent({ command: 'task.pickup', reservationId: decided['reservationId'] }),
    );
    detailOf(
      await asPerson({
        command: 'task.set_type',
        recordId: ticket,
        expectedRevision: await revisionOf(ticket),
        taskType: 'research',
      }),
    );
    return { ticket, delegation: String(picked['credential']) };
  };

  beforeAll(async () => {
    // A synthetic signing key for the approval, as the schedules harness sets one.
    process.env['GATE_SIGNING_KEY_ID'] = 'test/wf7cli@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    fixture = await createApiFixture('wf7cli');
    api = fixture.compose();
  }, 180_000);

  afterAll(async () => await fixture?.drop());

  it('WF-7 CLI parity: the agent resolves its ticket through the client, and another ticket is refused as the envelope refuses it', async () => {
    const { ticket, delegation } = await pickedResearch();
    const cli = createCli({
      businessKey: BUSINESS_KEY,
      credential: await tokenFor(fixture.agent.subject),
      entry: 'agent',
      delegation,
      transport: async (path, body, bearer, held) =>
        await api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${bearer}`,
              ...(held === undefined ? {} : { 'x-agent-delegation': held }),
            },
            body,
          }),
        ),
    });
    const field = (answer: CliAnswer, key: string): unknown => (answer.body as Body)[key];
    const resolveBody = async (recordId: string) => ({
      operationId: randomUUID(),
      recordId,
      expectedRevision: await revisionOf(recordId),
      answer: 'the cited answer',
      gist: 'the gist',
    });

    const other = await created('wf7 cli another ticket');
    const cliRefusal = await cli.run('task.resolve', await resolveBody(other));
    const direct = await asAgent(
      { command: 'task.resolve', ...(await resolveBody(other)) },
      delegation,
    );
    expect(cliRefusal.status).toBe(403);
    expect(field(cliRefusal, 'code')).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect((direct as { code?: string }).code).toBe('DELEGATION_OUT_OF_PURPOSE');
    expect(field(cliRefusal, 'names')).toStrictEqual((direct as { names?: unknown }).names);

    const resolved = await cli.run('task.resolve', await resolveBody(ticket));
    expect(resolved.status).toBe(200);
    expect(field(resolved, 'recordId')).toBe(ticket);
    const stored = await fixture.db.admin.execute<{ readonly gist: string | null }>(
      `select data->>'gist' as gist from public.records where business_id = $1 and id = $2`,
      [fixture.business, ticket],
    );
    expect(stored.map((row) => row.gist)).toStrictEqual(['the gist']);
  }, 180_000);
});
