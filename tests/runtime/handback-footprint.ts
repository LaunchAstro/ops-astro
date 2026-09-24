// SPDX-License-Identifier: AGPL-3.0-only
//
// What a handback may move, read back as exact text, shared by the Sol 6
// runtime suites at 158d6de (lease expiry after the lock wait, exact successor
// bounds). A refused handback is proved by this footprint not moving.

import { freshPurpose, rows, type Body, type Schedules } from './schedules-harness.ts';

export function successorBody(maximumMinor: number): Body {
  return {
    purpose: freshPurpose(),
    maximumMinor,
    currency: 'AUD',
    payload: { instruction: 'draft a reply to the client' },
    step: { kind: 'compose', payload: { tone: 'plain' } },
  };
}

export /** Everything a handback may move, as exact text, so "nothing moved" is one comparison. */
async function handbackFootprint(
  s: Schedules,
  leaseId: unknown,
): Promise<Readonly<Record<string, string>>> {
  const found = await rows<Readonly<Record<string, string>>>(
    s,
    `select
       (select l.state || ':' || l.fence::text || ':' || l.expires_at::text
          from public.leases l where l.business_id = $1 and l.id = $2) as lease,
       (select string_agg(r.id::text || ':' || r.state || ':' || r.held_minor::text, ',' order by r.id)
          from public.reservations r where r.business_id = $1) as reservations,
       (select string_agg(e.id::text || ':' || e.held_minor::text || ':' || e.actual_minor::text, ','
                          order by e.id)
          from public.task_envelopes e where e.business_id = $1) as envelopes,
       (select string_agg(g.id::text || ':' || g.state, ',' order by g.id)
          from public.gates g where g.business_id = $1) as gates,
       (select count(*) from public.proposal_versions where business_id = $1)::text as versions,
       (select count(*) from public.handback_reports
         where business_id = $1 and disposition = 'settled')::text as settled`,
    [s.business, leaseId],
  );
  return found[0] ?? {};
}

export async function retainedCodes(s: Schedules, leaseId: unknown): Promise<readonly string[]> {
  const found = await rows<{ readonly code: string }>(
    s,
    `select refusal_code as code from public.handback_reports
      where business_id = $1 and lease_id = $2 and disposition = 'retained'`,
    [s.business, leaseId],
  );
  return found.map((row) => row.code);
}
