// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-3's backup store in staging's definition (ticket S0-3, lines C1 and C11;
// ORCH25-SL01-STORE). `S0-3 store persists`: the store is a database server of
// its own, `backups`, on staging's internal network with no port, whose data is
// on the one persistent volume staging has, so a restart of the store, of
// staging or of the machine keeps every backup and every drill receipt. Its
// bound is the store's own (`S0-3 store bounded`, tests/db/backup-store-bounded
// .test.ts); S0-1's disk row names its volume as its only exception
// (tests/ci/staging-containment.test.ts).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Service = {
  container_name?: string;
  image?: string;
  environment?: Record<string, string>;
  command?: string[];
  volumes?: string[];
  networks?: string[];
  ports?: string[];
  read_only?: boolean;
};
type Definition = {
  services: Record<string, Service>;
  volumes: Record<string, { name: string; driver_opts?: Record<string, string> }>;
};

const load = (): Definition =>
  JSON.parse(
    readFileSync(new URL('../../deploy/staging/compose.json', import.meta.url), 'utf8'),
  ) as Definition;

const STORE_VOLUME = 'ops-astro-staging-backups-data';
const DATA = '/var/lib/postgresql/data';

describe('S0-3 store persists', () => {
  it('the store is its own server on staging’s network, with no port', () => {
    const def = load();
    const store = def.services['backups'];
    expect(store?.container_name).toBe('ops-astro-staging-backups');
    // The production major, pinned by digest.
    expect(store?.image).toMatch(/^postgres:17-alpine@sha256:[0-9a-f]{64}$/u);
    expect(store?.environment?.['POSTGRES_DB']).toBe('ops_astro_staging_backups');
    expect(store?.networks).toEqual(['staging']);
    expect(store?.ports).toBeUndefined();
    // TLS on the wire, as the source database: the job and the drill require it.
    expect(store?.command).toEqual(expect.arrayContaining(['ssl=on']));
    expect(store?.volumes).toContain('ops-astro-staging-tls:/etc/ops-astro-tls:ro');
  });

  it('its data is on a persistent volume, never memory-backed', () => {
    const def = load();
    expect(def.services['backups']?.volumes).toContain(`${STORE_VOLUME}:${DATA}`);
    const volume = def.volumes[STORE_VOLUME];
    expect(volume?.name).toBe(STORE_VOLUME);
    expect(volume?.driver_opts).toBeUndefined();
  });

  it('no other service holds the store’s volume', () => {
    const def = load();
    const others = Object.entries(def.services).filter(([name]) => name !== 'backups');
    for (const [name, service] of others)
      expect(
        (service.volumes ?? []).some((v) => v.startsWith(`${STORE_VOLUME}:`)),
        name,
      ).toBe(false);
  });
});
