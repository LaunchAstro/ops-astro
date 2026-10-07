// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  changeActivation,
  claimOccurrence,
  connect,
  listRegistry,
  releaseVersion,
  type OccurrenceClaim,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { createAutomationWorld, DIGEST } from '../../tests/automations/world.ts';

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new Error('promise executor has not run');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('a concurrent release and re-pin cannot leave a registry activation without its version', async () => {
  const w = await createAutomationWorld('sol371registry');
  const writer = connect(w.db.appUrl);
  try {
    const first = await w.release(['manual']);
    const activation = await w.activate(first, 'manual');
    let interleavedWrite = false;
    const registry = await w.inAlpha(async (tx) => {
      const interleaved: TenantQuery = {
        businessId: tx.businessId,
        async query<Row>(sql: string, params?: readonly unknown[]): Promise<readonly Row[]> {
          const rows = await tx.query<Row>(sql, params);
          // Complete a real writer transaction after the version list was read,
          // before listRegistry reads the activations.
          if (sql.includes('public.definition_versions') && !interleavedWrite) {
            interleavedWrite = true;
            await writer.withBusiness(w.alpha, async (other) => {
              const version = await releaseVersion(other, {
                definitionId: w.definition,
                contentDigest: DIGEST,
                contentSize: 1234,
                inputs: [],
                operations: [],
                modes: ['manual'],
                actorId: w.admin.actorId,
              });
              if (version === null || version === 'raced') throw new Error('release failed');
              expect(
                await changeActivation(other, activation.id, activation.revision, {
                  versionId: version.id,
                  mode: 'manual',
                  everyMinutes: null,
                  eventKind: null,
                  enabled: true,
                  actorId: w.admin.actorId,
                }),
              ).not.toBeNull();
            });
          }
          return rows;
        },
      };
      return await listRegistry(interleaved);
    });
    expect(interleavedWrite).toBe(true);
    expect(registry.activations).toHaveLength(1);
    const versions = new Set(registry.versions.map((version) => version.id));
    expect(registry.activations.filter((row) => !versions.has(row.versionId))).toEqual([]);
  } finally {
    await writer.close();
    await w.db.drop();
  }
});

it('independent schedulers and event deliveries commit one occurrence per cause', async () => {
  const w = await createAutomationWorld('sol371claims');
  const workers = connect(w.db.appUrl, { max: 4 });
  const ready = deferred();
  let selected = 0;
  try {
    const version = await w.release(['scheduled', 'event']);
    const scheduled = await w.activate(version, 'scheduled');
    const evented = await w.activate(version, 'event');
    const dueAt = new Date('2026-10-04T01:00:00Z');
    const requests = [
      { id: scheduled.id, cause: { dueAt } },
      { id: scheduled.id, cause: { dueAt } },
      { id: evented.id, cause: { eventId: 'sol-real-race' } },
      { id: evented.id, cause: { eventId: 'sol-real-race' } },
    ];
    const results = await Promise.all(
      requests.map(
        async ({ id, cause }) =>
          await workers.withBusiness(w.alpha, async (tx) => {
            const concurrent: TenantQuery = {
              businessId: tx.businessId,
              async query<Row>(sql: string, params?: readonly unknown[]): Promise<readonly Row[]> {
                const rows = await tx.query<Row>(sql, params);
                if (sql.includes("set_config('ops_astro.activation'")) {
                  selected += 1;
                  if (selected === 4) ready.resolve();
                  await ready.promise;
                }
                return rows;
              },
            };
            return await claimOccurrence(concurrent, id, cause);
          }),
      ),
    );
    expect(selected).toBe(4);
    expect(
      results
        .slice(0, 2)
        .map((row) => row.kind)
        .toSorted(),
    ).toEqual(['claimed', 'replayed']);
    expect(
      results
        .slice(2)
        .map((row) => row.kind)
        .toSorted(),
    ).toEqual(['claimed', 'replayed']);
    expect(await w.occurrences(scheduled.id)).toBe(1);
    expect(await w.occurrences(evented.id)).toBe(1);
  } finally {
    ready.resolve();
    await workers.close();
    await w.db.drop();
  }
});

it('the occurrence race fixture permits claim transactions to overlap', async () => {
  const w = await createAutomationWorld('sol371race');
  const blocker = connect(w.db.appUrl);
  const locked = deferred();
  const unlock = deferred();
  let holding: Promise<void> | undefined;
  let attempts: Promise<readonly OccurrenceClaim[]> | undefined;
  try {
    const version = await w.release(['scheduled', 'event']);
    const scheduled = await w.activate(version, 'scheduled');
    const evented = await w.activate(version, 'event');
    holding = blocker.withBusiness(w.alpha, async (tx) => {
      await tx.query('select id from public.activations where id = any($1::uuid[]) for update', [
        [scheduled.id, evented.id],
      ]);
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    const dueAt = new Date('2026-10-04T00:00:00Z');
    // Exactly the four calls in c33-occurrences.test.ts, kept pending together.
    attempts = Promise.all([
      w.claim(scheduled.id, { dueAt }),
      w.claim(scheduled.id, { dueAt }),
      w.claim(evented.id, { eventId: 'sol-race' }),
      w.claim(evented.id, { eventId: 'sol-race' }),
    ]);
    let maximumWaiting = 0;
    for (let poll = 0; poll < 100 && maximumWaiting < 2; poll += 1) {
      const rows = await w.db.admin.execute<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and usename = $1
            and wait_event_type = 'Lock' and query like '%from public.activations%for update%'`,
        [w.db.loginRole],
      );
      maximumWaiting = Math.max(maximumWaiting, rows[0]?.n ?? 0);
      await delay(20);
    }
    expect(
      maximumWaiting,
      'at least two purported racing callers must reach Postgres concurrently',
    ).toBeGreaterThanOrEqual(2);
  } finally {
    unlock.resolve();
    await holding;
    await attempts;
    await blocker.close();
    await w.db.drop();
  }
});
