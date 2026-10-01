// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12, part two: the harness read through the real API boundary and the
// shipped command-line client, over AW-12's trigger world (two businesses,
// picked-up work under a live delegation, a helper agent of each). A
// harness, not a suite.

import type { Hono } from 'hono';
import { beforeAll } from 'vitest';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import { createCli, type CliAnswer } from '../../apps/cli/client.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
} from '../../packages/core-commands/src/index.ts';
import { DELEGATION_HEADER, PREFIX } from '../../packages/core-wire/src/index.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { noDatabase, w } from '../runtime/aw-11-child-world.ts';
import type { Schedules } from '../runtime/schedules-harness.ts';

export interface Answer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

const route = {} as { api: Hono; keys: Map<string, string> };

/** Mounts the boundary over the child world, once per file, after the world opens. */
export function useHarnessRoute(): void {
  beforeAll(async () => {
    if (noDatabase) return;
    route.api = createApi({
      database: w.s.db.app,
      verify: createSupabaseVerifier(testSignIn(ISSUER)),
      resolveBusiness: createBusinessResolver(w.s.db.admin),
      executeRead,
      executeCommand,
      executeAgentCommand,
    });
    route.keys = new Map();
    for (const on of [w.s, w.bravo]) {
      // eslint-disable-next-line no-await-in-loop -- two businesses, one key each
      const [row] = await w.s.db.admin.execute<{ readonly key: string }>(
        'select key from public.businesses where id = $1',
        [on.business],
      );
      route.keys.set(on.business, String(row?.key));
    }
  }, 60_000);
}

const fetchOn = async (path: string, body: string, headers: Record<string, string>) =>
  await route.api.fetch(
    new Request(`http://api.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
  );

/** `harness.read` on `runId`, as `who` on `on`'s business; on the agent prefix with `delegation`. */
export async function harnessOver(
  on: Schedules,
  who: { readonly presented: VerifiedSubject },
  runId: string,
  delegation?: string,
): Promise<Answer> {
  const prefix = delegation === undefined ? PREFIX.person : PREFIX.agent;
  const headers: Record<string, string> = {
    authorization: `Bearer ${await tokenFor(who.presented.subject)}`,
    ...(delegation === undefined ? {} : { [DELEGATION_HEADER]: delegation }),
  };
  const path = `${prefix}${String(route.keys.get(on.business))}/harness/read`;
  const response = await fetchOn(path, JSON.stringify({ runId }), headers);
  return { status: response.status, body: (await response.json()) as Answer['body'] };
}

/** `harness.read` on `runId` through the shipped command-line client, as `who`. */
export async function harnessOnCli(
  on: Schedules,
  who: { readonly presented: VerifiedSubject },
  runId: string,
): Promise<CliAnswer> {
  const cli = createCli({
    businessKey: String(route.keys.get(on.business)),
    credential: await tokenFor(who.presented.subject),
    transport: async (path, body, bearer) =>
      await fetchOn(path, body, { authorization: `Bearer ${bearer}` }),
  });
  return await cli.run('harness.read', { runId });
}
