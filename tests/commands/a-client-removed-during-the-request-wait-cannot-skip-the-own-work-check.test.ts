// SPDX-License-Identifier: AGPL-3.0-only
//
// No database: it exercises the real request, insert and final own-work check.
// The transaction double supplies a legal READ COMMITTED schedule: a client is
// removed while shareClientSite waits, before insertLiveCorrection locks the task.
import { expect, it, vi } from 'vitest';
import type { Delegation, TenantQuery } from '../../packages/core-records/src/index.ts';
import type { Applied } from '../../packages/core-commands/src/commands/outcome.ts';

const checks = vi.hoisted(() => ({ scopes: [] as unknown[], finalParties: [] as unknown[] }));
vi.mock('../../packages/core-records/src/index.ts', async (original) => ({
  ...(await original<typeof import('../../packages/core-records/src/index.ts')>()),
  checkAuthority: (_tx: unknown, _subjects: unknown, request: { scope: unknown }) => {
    checks.scopes.push(request.scope);
    // The delegator has a live business-wide run:write grant.
    return Promise.resolve({ ok: true });
  },
}));
vi.mock('../../packages/core-commands/src/commands/context.ts', () => ({
  readTaskSpine: () => Promise.resolve({ taskTypeId: 'task-type' }),
}));
vi.mock('../../packages/core-commands/src/commands/live-correction-decision-checks.ts', () => ({
  approverConfigured: () => Promise.resolve(true),
}));
vi.mock('../../packages/core-commands/src/commands/live-correction-standing.ts', () => ({
  standsAfterWaits: (_tx: unknown, standing: { partyId: unknown }) => {
    checks.finalParties.push(standing.partyId);
    return Promise.resolve('stands');
  },
}));
import { requestOperands } from '../../packages/core-commands/src/commands/live-corrections.ts';
import { requestAsAgent } from '../../packages/core-commands/src/commands/live-correction-agent.ts';

const business = '11111111-1111-4111-8111-111111111111';
const task = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const person = '44444444-4444-4444-8444-444444444444';
const agent = '55555555-5555-4555-8555-555555555555';
const delegation = {
  id: '66666666-6666-4666-8666-666666666666',
  purposeScope: { kind: 'record', id: task },
  collections: ['run'],
  actions: ['write'],
  delegatePersonId: person,
} as unknown as Delegation;

// oxlint-disable-next-line max-lines-per-function -- the request, its storage and the final check under one schedule
it('a client removed during the request wait cannot bypass the own-work source rule', async () => {
  let party: string | null = client;
  let insertedParty: string | null | undefined;
  let sourceReads = 0;
  const tx = {
    businessId: business,
    // oxlint-disable-next-line max-lines-per-function, require-await -- one READ COMMITTED schedule, answered query by query
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('select r.uuid_7 as party')) return [{ party }];
      if (sql.includes('select id from public.records')) return [{ id: task }];
      if (sql.includes('from public.leases l')) {
        // No pickup minted this delegation, so it serves no plan version.
        expect(params).toEqual([business, delegation.id]);
        return [];
      }
      if (sql.includes('select 1 from public.party_sites')) {
        // The other connection commits its removal before this wait completes.
        party = null;
        return [{ '?column?': 1 }];
      }
      if (sql.includes('insert into public.live_corrections')) {
        expect(sql).toContain('for share of r');
        if (sql.includes('r.uuid_7 is not distinct from $3::uuid') && party !== params[2])
          return [];
        insertedParty = party;
        return [
          {
            id: params[1],
            party_id: party,
            task_id: task,
            requested_by_actor_id: agent,
            requested_by_person_id: person,
            delegation_id: delegation.id,
            target_path: 'src/pages/about.md',
            word: 'friendly',
            replacement: 'welcoming',
            page_url: 'https://own.example/about',
            pre_image_digest: null,
            base_revision: null,
            seam: params[6],
            version_id: null,
            version_digest: null,
            state: 'locating',
            decided_by_person_id: null,
            decided_version_digest: null,
            revision: 1,
          },
        ];
      }
      if (sql.includes('from public.records t where')) {
        sourceReads++;
        return [
          {
            id: task,
            client: party,
            live: true,
            data: { source: 'person:app' },
            others_wrote: true,
            client_typed: false,
            owner_started: true,
          },
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as TenantQuery;
  const result = await requestAsAgent(
    tx,
    agent,
    {
      ...requestOperands({
        taskId: task,
        page: 'About',
        word: 'friendly',
        replacement: 'welcoming',
        partyId: null,
        path: 'src/pages/about.md',
        pageUrl: 'https://own.example/about',
        baseRevision: 'c0'.repeat(20),
        before: 'We are friendly.',
        after: 'We are welcoming.',
      }),
    },
    delegation,
  );
  expect(result).not.toHaveProperty('refused', true);
  expect(insertedParty).toBeNull();
  expect(checks.finalParties).toEqual([null]);
  const refusal = await (result as Applied).lastCheck?.();
  expect({ refusal: refusal?.code, sourceReads }).toEqual({
    refusal: 'CORRECTION_NOT_OWN_WORK',
    sourceReads: 1,
  });
});
