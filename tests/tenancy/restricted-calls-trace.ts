// SPDX-License-Identifier: AGPL-3.0-only
//
// The trace export's role (#1708, 20261018222300): the column grants its
// migration makes, spread into `restricted-calls-catalogue.ts` with the rest.
// A run event's task, attempt and actor are left out; the lease and model-call
// columns are the ones the call counts read.

const FROM = '20261018222300';
const ROLE = 'ops_astro_trace';

const COLUMNS: readonly (readonly [string, string, string])[] = [
  [
    'SELECT',
    'public.run_events',
    'business_id created_at detail id kind lease_id position run_id tx written_at',
  ],
  ['SELECT', 'public.leases', 'business_id id reservation_id'],
  [
    'SELECT',
    'public.model_calls',
    'accepted_at business_id ended_at lease_id reservation_id run_id state',
  ],
  ['SELECT', 'public.copy_registrations', 'business_id copy_class copy_key'],
  [
    'INSERT',
    'public.copy_registrations',
    'business_id copy_class copy_key id invalidation_trigger retention_class',
  ],
];

export const TRACE_GRANTS: readonly { readonly from: string; readonly line: string }[] =
  COLUMNS.flatMap(([act, table, columns]) =>
    columns.split(' ').map((column) => ({ from: FROM, line: `${ROLE} ${act} ${table}.${column}` })),
  );
