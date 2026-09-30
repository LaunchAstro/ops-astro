// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-1 gated stop suites' shared fixtures (service-stop.test.ts and
// service-stop-gated.test.ts): the stop command as a process, a fake service
// manager and the callers.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { signBearer, signForged, TEST_ISSUER } from '../support/sign-in.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';

export const STOP: string = new URL('../../scripts/ops/stop-production.mjs', import.meta.url)
  .pathname;

export const PROMOTE: string = new URL('../../scripts/ops/promote.mjs', import.meta.url).pathname;

export const definition = JSON.parse(
  readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
) as { 'x-ops-astro': { artefact: string } };

/** The one call the stop may make: both named services, nothing else. */
export const THE_STOP = 'docker stop ops-astro-api ops-astro-auth';

export const ISSUER: string = TEST_ISSUER;

export const CANARY = 'canary-3e91d0-stop-secret';

export const STAGED = '0123456789ab';

export const serverUrl: string | undefined = databaseUrlFromEnvironment();

// Made by the file's first hook, so a file whose tests all skip leaves no folder (temp guard).
export const scratch: string = join(tmpdir(), `s0-1g-${randomBytes(6).toString('hex')}`);
beforeAll(() => mkdirSync(scratch, { mode: 0o700 }));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A sign-in's ES256 bearer, as the provider issues it; `forged` signs with a stranger's key. */
export const token = async (subject: string, forged = false): Promise<string> =>
  await (forged ? signForged : signBearer)({
    sub: subject,
    aud: 'authenticated',
    iss: ISSUER,
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 600,
  });

export interface Fake {
  readonly path: string;
  readonly calls: string;
  readonly records: string;
}

/**
 * A PATH whose docker and launchctl log every call. The rest of the PATH is
 * the system's own folders, which hold no docker, so a call that escapes the
 * fake fails instead of reaching a live service. `inspect` answers with the
 * production containers running, as they are before the stop.
 */
export const fake = (stopExit = 0): Fake => {
  const bin = mkdtempSync(join(scratch, 'bin-'));
  const calls = join(bin, 'calls.log');
  const inspect = JSON.stringify(
    ['ops-astro-api', 'ops-astro-auth'].map((name) => ({
      Name: `/${name}`,
      State: { Running: true },
      HostConfig: {},
    })),
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh\necho "docker $*" >> '${calls}'\nif [ "$1" = stop ]; then exit ${stopExit}; fi\nif [ "$1" = ps ]; then echo api-id; exit 0; fi\nif [ "$1" = inspect ]; then printf '%s\\n' '${inspect}'; exit 0; fi\nexit 2\n`,
  );
  writeFileSync(
    join(bin, 'launchctl'),
    `#!/bin/sh\necho "launchctl $*" >> '${calls}'\nprintf 'PID\\tStatus\\tLabel\\n'\n`,
  );
  for (const command of ['docker', 'launchctl']) chmodSync(join(bin, command), 0o755);
  return { path: `${bin}:/usr/bin:/bin`, calls, records: mkdtempSync(join(scratch, 'records-')) };
};

export interface Run {
  readonly status: number | null;
  readonly out: string;
}

export const spawn = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
): Run => {
  const result = spawnSync(process.execPath, [command, ...args], {
    encoding: 'utf8',
    env: { HOME: process.env['HOME'] ?? '', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

export const untouched = (at: Fake): void => {
  expect(existsSync(at.calls), 'the service manager was asked').toBe(false);
  expect(readdirSync(at.records), 'a record was written').toEqual([]);
};

/** A person with a login and a membership; the grant, if any, is on `operations`. */
export const person = async (
  tx: TenantQuery,
  name: string,
  subject: string,
  grant?: { scope: 'business' | 'party'; action?: 'manage' | 'read' },
): Promise<string> => {
  const id = await insertPerson(tx, name);
  const actor = await insertActor(tx, id);
  await insertMembership(tx, id);
  await insertMapping(tx, await insertLogin(tx, subject), id, actor);
  if (grant !== undefined) {
    const issued = await issueGrant(tx, [{ kind: 'actor', id: actor }], {
      subject: { kind: 'person', id },
      scope:
        grant.scope === 'business'
          ? { kind: 'business', id: null }
          : { kind: 'party', id: randomUUID() },
      collection: 'operations',
      action: grant.action ?? 'manage',
      parentGrantId: null,
      grantedByActorId: actor,
    });
    expect(issued.ok).toBe(true);
  }
  return id;
};

export const subjects = {
  operator: `op-${randomUUID()}`,
  second: `op2-${randomUUID()}`,
  keyless: `kl-${randomUUID()}`,
  client: `cl-${randomUUID()}`,
  agent: `ag-${randomUUID()}`,
  betaOperator: `bo-${randomUUID()}`,
};

// Each caller names the separation its refusal proves.
export const CALLERS: Record<string, () => Promise<Record<string, string>>> = {
  'an agent credential (person to agent)': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.agent),
  }),
  "the operator's own sign-in under a delegation (person to delegate)": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator),
    OPS_ASTRO_DELEGATION: CANARY,
  }),
  "the operator's own sign-in with a saved delegation (person to delegate)": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator),
    OPS_ASTRO_DELEGATION_FILE: join(scratch, 'delegation'),
  }),
  'a person without the key, operations:read only (person to person)': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.keyless),
  }),
  'a person holding the key for one client only (client to client)': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.client),
  }),
  "another business's operator (business to business)": async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.betaOperator),
  }),
  'a forged sign-in': async () => ({
    OPS_ASTRO_TOKEN: await token(subjects.operator, true),
  }),
};
