// SPDX-License-Identifier: AGPL-3.0-only
//
// #2240 (Sol's S2243-4). The function's database connection goes through a
// relay that never delivers a cancel request. The pass's lease update is
// slowed 1,700 ms, and the reservation update after it, in the same
// transaction, waits on a row a holder keeps. With the driver's cancel lost,
// only the server's own limit on that statement, and the connection closed
// once the cancel is not taken, end the wait: health still answers within
// the shared request bound.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { cancelRelay, type CancelRelay } from '../support/cancel-relay.ts';
import { boundWorld, request, withinBound } from './recovery-pass-bound-world.ts';

/** A lease update slowed 1,700 ms, and a reservation update that needs the gate's one row. */
const SLOW_LEASE_THEN_GATED_RESERVATION = (login: string): string => `
  create table public.cancel_gate (n int primary key);
  insert into public.cancel_gate values (1);
  grant select, update on public.cancel_gate to "${login}";
  create function public.slow_lease() returns trigger language plpgsql as $$
    begin perform pg_sleep(1.7); return new; end $$;
  create trigger slow_lease before update on public.leases
    for each row execute function public.slow_lease();
  create function public.gated_reservation() returns trigger language plpgsql as $$
    begin perform 1 from public.cancel_gate where n = 1 for update; return new; end $$;
  create trigger gated_reservation before update on public.reservations
    for each row execute function public.gated_reservation();
`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('a lost cancel', () => {
  it('Sol proof, criterion 2: a lost cancel cannot hold hosted health past the shared request bound', async () => {
    let relay: CancelRelay | undefined;
    const world = await boundWorld('lostcancelhost', async (appUrl) => {
      relay = await cancelRelay(appUrl, 'lost');
      return relay.url;
    });
    const { s } = world;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await s.db.admin.execute(SLOW_LEASE_THEN_GATED_RESERVATION(s.db.loginRole));
      const holder = world.holder();
      await holder.query('begin');
      await holder.query('select 1 from public.cancel_gate for update');
      const started = performance.now();
      const result = await withinBound(world.handle(request('/api/health')), started);
      console.log('hosted lost cancel:', result, Math.round(performance.now() - started), 'ms');
      expect(relay?.cancels(), 'the pass sent one cancel, which was lost').toBe(1);
      expect(result, 'the lost cancel held health past the bound').toBe(200);
    } finally {
      await world.end();
      await relay?.end();
    }
  }, 30_000);
});
