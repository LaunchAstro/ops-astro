// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent CLI's world (API-3): the wayfinder world's two businesses, its
// scoped members and its agent, with the real API composed over the same
// database and the verb CLI driven over it in process. Every call goes through
// `createVerbCli`, the Hono app and the envelopes the routes call; the
// transport counts its round trips so a case can show one call is one request.

import type { Hono } from 'hono';
import { composeApi } from '../../apps/api/server.ts';
import { createVerbCli, type VerbAnswer } from '../../apps/cli/verbs.ts';
import type { Transport } from '../../apps/cli/client.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { wayfinderWorld, type WayfinderWorld } from '../wayfinder/world.ts';
import type { Member } from '../commands/fixture.ts';

export interface Caller {
  /** Run one command line, as `pnpm cli` would split it. */
  run(...argv: string[]): Promise<VerbAnswer>;
  /** HTTP requests this caller has sent so far. */
  requests(): number;
}

export interface CliWorld extends WayfinderWorld {
  readonly key: string;
  readonly api: Hono;
  /** A person on the person prefix, in `business` (alpha by default). */
  person(member: Member, businessKey?: string): Promise<Caller>;
  /** The world's agent on the agent prefix, under the delegation credential given. */
  agent(delegation: string): Promise<Caller>;
}

function caller(
  api: Hono,
  credential: string,
  businessKey: string,
  entry: 'person' | 'agent',
  delegation?: string,
): Caller {
  let sent = 0;
  const transport: Transport = async (path, body, bearer, held) => {
    sent += 1;
    return await api.fetch(
      new Request(`http://api.test${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
          ...(held === undefined ? {} : { [DELEGATION_HEADER]: held }),
        },
        body,
      }),
    );
  };
  const cli = createVerbCli({
    transport,
    businessKey,
    credential,
    entry,
    ...(delegation === undefined ? {} : { delegation }),
  });
  return { run: async (...argv) => await cli.run(argv), requests: () => sent };
}

export async function cliWorld(part: string, key: string): Promise<CliWorld> {
  const world = await wayfinderWorld(part, key);
  const api = composeApi({
    keys: runtimeKeys({ ...process.env }),
    database: world.db.app,
    admin: world.db.admin,
    signIn: testSignIn(ISSUER),
    executeRead,
  }).app;

  return {
    ...world,
    key,
    api,
    async person(member, businessKey = key) {
      return caller(api, await tokenFor(member.presented.subject), businessKey, 'person');
    },
    async agent(delegation) {
      return caller(api, await tokenFor(world.agentSubject()), key, 'agent', delegation);
    },
  };
}

/** The first token of a write's one-line result: the record it touched. */
export const idOf = (answer: VerbAnswer): string => {
  const match = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/u.exec(
    answer.out,
  );
  if (match === null) throw new Error(`no record id in: ${answer.out}`);
  return match[1] as string;
};

/** The revision a write's one-line result reports (`r<n>`). */
export const revisionIn = (answer: VerbAnswer): string => {
  const match = /\br(\d+)\b/u.exec(answer.out);
  if (match === null) throw new Error(`no revision in: ${answer.out}`);
  return match[1] as string;
};
