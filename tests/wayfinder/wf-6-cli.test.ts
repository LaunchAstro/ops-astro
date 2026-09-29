// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- one suite per ticket: one case per command on one composed API */
//
// WF-6 from the command line: `map.chart` with cited pre-answers through the
// generated client over the composed API, the same result as the envelope
// and the same refusal for an uncited one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createCli, type CliAnswer, type Transport } from '../../apps/cli/client.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { createApiFixture, BUSINESS_KEY, tokenFor, type ApiFixture } from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

type Body = Readonly<Record<string, unknown>>;

describe.skipIf(serverUrl === undefined)('WF-6 from the command line', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let cli: ReturnType<typeof createCli>;

  const run = async (verb: string, body: Body): Promise<CliAnswer> =>
    await cli.run(verb, verb === 'map.view' ? body : { operationId: randomUUID(), ...body });
  const field = (answer: CliAnswer, key: string): unknown => (answer.body as Body)[key];

  beforeAll(async () => {
    fixture = await createApiFixture('wf6cli');
    api = fixture.compose();
    const credential = await tokenFor(fixture.member.presented.subject);
    const transport: Transport = async (path, body, bearer) =>
      await api.fetch(
        new Request(`http://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
          body,
        }),
      );
    cli = createCli({ transport, businessKey: BUSINESS_KEY, credential });
  }, 180_000);

  afterAll(async () => await fixture?.drop());

  it('WF-6 CLI map.chart files cited pre-answers and refuses an uncited one, as the envelope does', async () => {
    const preAnswers = [
      {
        question: 'Key style?',
        answer: 'kebab',
        source: { reference: 'the brief' },
        vetoOpen: true,
      },
    ];
    const charted = await run('map.chart', { title: 'cli chart', preAnswers });
    expect(charted.status).toBe(200);
    const map = String(field(charted, 'recordId'));
    const shown = field(await run('map.view', { recordId: map }), 'map') as {
      preAnswers: readonly {
        question: string;
        answer: string;
        vetoOpen: boolean;
        source: unknown;
      }[];
    };
    expect(shown.preAnswers.map((p) => [p.question, p.answer, p.vetoOpen, p.source])).toStrictEqual(
      [['Key style?', 'kebab', true, { reference: 'the brief' }]],
    );
    const uncited = [{ question: 'q', answer: 'a' }];
    const cliRefusal = await run('map.chart', { title: 'x', preAnswers: uncited });
    const direct = await executeCommand(
      fixture.db.app,
      fixture.business,
      fixture.member.presented,
      'api',
      { command: 'map.chart', operationId: randomUUID(), title: 'x', preAnswers: uncited } as never,
    );
    expect(field(cliRefusal, 'code')).toBe('FIELD_VALUE_INVALID');
    expect((direct as { code?: string }).code).toBe('FIELD_VALUE_INVALID');
    expect(field(cliRefusal, 'names')).toStrictEqual((direct as { names?: unknown }).names);
  });
});
