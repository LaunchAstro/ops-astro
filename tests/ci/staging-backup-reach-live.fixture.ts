// SPDX-License-Identifier: AGPL-3.0-only
//
// The live store suite's shared parts (staging-backup-reach-live.test.ts): the
// job's and the drill's modules, the one route to the store (psql on
// staging's network), and a passed drill recorded as the appointed operator.

import { randomUUID } from 'node:crypto';

export type Reach = (
  url: string,
  script: string | Iterable<string> | AsyncIterable<string>,
  onLine?: (line: string) => unknown,
) => Promise<string>;
export type JobModule = {
  runBackup: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
  expireBackups: (o: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
export type DrillModule = {
  fetchLatest: (
    url: string,
    file: string,
    reach?: Reach,
  ) => Promise<{ archiveId: string; takenAt: string; sha256: string; bytes: number }>;
  recordDrill: (
    url: string,
    who: string,
    record: Record<string, unknown>,
    reach?: Reach,
    bound?: Record<string, unknown>,
  ) => Promise<string | null>;
};

export const importOps = async <T>(name: string): Promise<T> => {
  const path = `../../scripts/ops/${name}`;
  return (await import(
    /* @vite-ignore */
    path
  )) as T;
};
export const reachOn = async (network: string): Promise<Reach> =>
  (await importOps<{ psqlOn: (n: string) => Reach }>('backup-store-reach.mjs')).psqlOn(network);
export const send = (): Promise<string> => Promise.resolve('sent');

/** The person the store's installation appoints, with the store login `logins.operator`. */
export const OPERATOR: string = randomUUID();

/**
 * A passed drill's receipt for the archive `fetched`, as the appointed
 * operator, through `reach`; answers the date of the last tested restore.
 */
export async function recordPassed(
  url: string,
  fetched: { archiveId: string; takenAt: string; sha256: string },
  reach: Reach,
): Promise<string | null> {
  const { recordDrill } = await importOps<DrillModule>('restore-drill.mjs');
  return await recordDrill(
    url,
    OPERATOR,
    {
      outcome: 'passed',
      stage: null,
      archiveTakenAt: fetched.takenAt,
      productionMajor: 17,
      sourceMajor: 17,
      targetMajor: 17,
      tables: 12,
      timings: { fetch: 1, open: 2, start: 3, restore: 4, check: 5 },
    },
    reach,
    { business: 'made-up', archiveId: fetched.archiveId, digest: fetched.sha256 },
  );
}
