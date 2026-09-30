// SPDX-License-Identifier: AGPL-3.0-only
//
// The S0-3e operating-business suites' shared parts
// (s0-3e-operating-business.test.ts, s0-3e-operating-business-installed.test.ts):
// the drill command's module, a planted store that counts each reach, a
// signed-in environment and every drill mode.

import { createHash, randomUUID } from 'node:crypto';
import { COMMANDS, manager, marks } from './operator-only-commands.fixture.ts';
import { environment, token } from './operator-only.fixture.ts';

export type Seal = {
  sealArchive: (dump: Buffer, publicKey: string) => Buffer;
  openArchive: (sealed: Buffer, privateKey: string) => Buffer;
};
export type Run = { refused?: string; mode?: string; receipt?: Record<string, unknown> };
export type Reach = (
  url: string,
  script: unknown,
  onLine?: (line: string) => unknown,
) => Promise<string>;
export type DrillCommand = {
  runDrillCommand: (
    args: string[],
    options: { environment: Record<string, string>; reach: Reach },
  ) => Promise<Run>;
};
export const load = async <T>(path: string): Promise<T> =>
  (await import(
    /* @vite-ignore */
    path
  )) as T;

export const TAKEN = '2026-09-29T02:00:00.000Z';
export const digestOf = (body: Buffer): string => createHash('sha256').update(body).digest('hex');

/** A store holding one sealed archive of `dump`, answering as the real one does; it counts each reach. */
export function plantedStore(body: Buffer): { reach: Reach; reached: () => number } {
  let reached = 0;
  const reach: Reach = (_url, _script, onLine) => {
    reached += 1;
    if (onLine === undefined) {
      const header = { id: randomUUID(), takenAt: TAKEN, bytes: body.length, parts: 1 };
      return Promise.resolve(JSON.stringify({ ...header, sha256: digestOf(body) }));
    }
    onLine(`0|${digestOf(body)}|${body.toString('hex')}`);
    return Promise.resolve('');
  };
  return { reach, reached: () => reached };
}

/** The drill command's environment for `subject`, signed in to `business`. */
export async function signedIn(
  subject: string,
  business: string,
): Promise<{ env: Record<string, string>; records: string }> {
  const at = marks(manager(false));
  const env = environment(at, process.env['PATH'] ?? '', {
    OPS_ASTRO_TOKEN: await token(subject),
    OPS_ASTRO_BUSINESS: business,
    RESTORE_STORE_URL: 'postgres://drill:never@127.0.0.1:1/never',
  });
  return { env, records: at.records };
}

/** Every mode of the restore drill, as the operator-only suites run it. */
export const drillModes: [string, (typeof COMMANDS)[string]][] = Object.entries(COMMANDS).filter(
  ([name]) => /restore drill|archive export|carried/u.test(name),
);
