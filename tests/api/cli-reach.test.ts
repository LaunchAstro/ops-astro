// SPDX-License-Identifier: AGPL-3.0-only
//
// The command line reaches the operations, by generation rather than by list.
//
// `apps/cli/client.ts` builds its verbs and its paths from `COMMAND_SURFACE`,
// and the claim that makes is that an operation cannot exist without the
// command line reaching it. A test that checked that claim against a list of
// its own would be checking one hand-kept list against another; the drift
// would live in exactly the place nobody reads. So the case below takes the
// surface itself as the list, posts every declaration on it through the
// generated client into the real in-process app, and asks one question of each
// answer: did this get past routing and come back with the operation's own
// code, rather than with "no such command" or a 404?
//
// It is one case on purpose. The question is about the surface as a whole —
// every declared operation is reachable — and splitting it per command would
// turn a claim about the table into twenty-eight claims about rows.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  COMMAND_SURFACE,
  declarationOf,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';
import { accepts, createCli, type CliAnswer, type Transport } from '../../apps/cli/client.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/cli: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

/**
 * The five the runtime journey is made of.
 *
 * They are named here as the subtask names them, and then *looked up in the
 * surface* rather than trusted: a declaration that has been renamed or removed
 * is a failed lookup and a failed case, not a case that quietly stops running.
 * The paths the client posts to are never written here at all — they come out
 * of `pathOf` inside `apps/cli/client.ts`, which is the generation this case
 * exists to check.
 */
const JOURNEY: readonly CommandName[] = [
  'task.propose',
  'task.decide',
  'task.queue',
  'task.pickup',
  'task.handback',
];

/** What a routing failure looks like from inside the client, whichever shape it takes. */
const ROUTING_CODES: ReadonlySet<string> = new Set(['COMMAND_UNKNOWN']);

describe.skipIf(serverUrl === undefined)(
  'the command line reaches the surface it generates',
  () => {
    let fixture: ApiFixture;
    let api: Hono;
    let credential: string;

    beforeAll(async () => {
      fixture = await createApiFixture('c');
      api = fixture.compose();
      credential = await tokenFor(fixture.member.presented.subject);
    }, 120_000);

    afterAll(async () => {
      await fixture?.drop();
    });

    it('posts every declared operation through the generated client and is answered by each', async () => {
      // A real task, so that the commands with a target have one. Nothing here
      // is about what they do with it: the question is reach.
      const created = await post(
        api,
        `/api/b/${BUSINESS_KEY}/task/create`,
        { operationId: randomUUID(), fields: { title: 'a task the command line can name' } },
        authorised(credential),
      );
      expect(created.status).toBe(200);
      const recordId = String(created.body['recordId']);
      const expectedRevision = Number(created.body['revision']);

      // The transport is the in-process app. The client is otherwise the one the
      // shipped command line builds: same verbs, same paths, same credential.
      const transport: Transport = async (path, body, bearer) =>
        await api.fetch(
          new Request(`http://api.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
            body,
          }),
        );
      const cli = createCli({ transport, businessKey: BUSINESS_KEY, credential });

      /** `run` reads the answer as JSON, and a missing route does not answer in JSON. */
      async function drive(verb: string): Promise<CliAnswer> {
        try {
          return await cli.run(verb, {
            operationId: randomUUID(),
            recordId,
            expectedRevision,
            // Enough scaffolding that a command with a shape reaches its own
            // check rather than falling over on the way to it. Every field here
            // is generic: none of them names an operation.
            fields: {},
            recordTypeKey: 'task',
          });
        } catch (cause) {
          return {
            status: -1,
            body: { code: 'THE_CLIENT_COULD_NOT_READ_THE_ANSWER', detail: String(cause) },
          };
        }
      }

      const answers = new Map<string, CliAnswer>();
      for (const declaration of COMMAND_SURFACE) {
        // Sequential: these share one database and one register, and driving
        // them at once would be a concurrency case wearing a reach case's
        // clothes.
        // eslint-disable-next-line no-await-in-loop
        answers.set(declaration.name, await drive(declaration.name));
      }

      for (const [name, answer] of answers) {
        const code = String((answer.body as Record<string, unknown>)['code'] ?? '');
        // Past routing: not a 404, not the client's own "no such command", and
        // not an answer the client could not read.
        expect(answer.status, `${name} status`).not.toBe(404);
        expect(answer.status, `${name} status`).not.toBe(-1);
        expect(ROUTING_CODES.has(code), `${name} answered ${code}`).toBe(false);
        // Its own answer: either it applied, or it refused with a code of its own.
        const refused = (answer.body as Record<string, unknown>)['refused'] === true;
        expect(answer.status === 200 || (refused && code !== ''), `${name} -> ${code}`).toBe(true);
      }

      // The five the journey is made of, checked by name against the surface and
      // then against what the client really got back.
      for (const name of JOURNEY) {
        expect(declarationOf(name), `${name} is declared`).toBeDefined();
        expect(answers.has(name), `${name} was driven`).toBe(true);
        // The client's own answer about the verb, asked the way `usage()` asks it.
        expect(accepts(name), `${name} is a verb the command line takes`).toBe(true);
      }
      expect([...answers.keys()]).toHaveLength(COMMAND_SURFACE.length);
    }, 120_000);
  },
);
