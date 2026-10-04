// SPDX-License-Identifier: AGPL-3.0-only
//
// I06 and M02: the machinery for an actual call by every restricted role
// against every table and function the migrations leave behind. A catalogue
// assertion says what a role was granted; this issues the statement and
// classifies the server's reply by SQLSTATE and message, because a policy, a
// trigger or a schema privilege sits between a grant and an answer.
//
// Only the contract is listed by hand: what the application group was granted.
// Tables, functions and roles are read from the migrated catalogue at call
// time, so a new table is covered without anybody extending a list, and one the
// contract does not name fails rather than being skipped. Nothing here asserts.

import { type AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';

export const WORKER_ROLE = 'ops_astro_worker';
/** The broker's role (AW-01): it executes the fair share's one count, and holds nothing else. */
export const BROKER_ROLE = 'ops_astro_broker';
export const OCCURRENCE_ROLE = 'ops_astro_occurrence';

/**
 * The contract: what the migrations grant the application group, table by table,
 * as `s` select, `i` insert, `u` update, `d` delete. Read from the `grant`
 * lines of the migrations, not from the catalogue this suite then checks.
 */
const GRANT_GROUPS: readonly (readonly [string, string])[] = [
  ['', 'ops.schema_migrations'],
  // 0045: the installation's operating business; the application reads it only.
  ['s', 'ops.operating_business'],
  // 0070 (C55): the date of the last tested restore; the application reads it
  // only, and the drill writes it through ops.record_tested_restore().
  ['s', 'ops.last_tested_restore'],
  // 0047: the API's outbox; the application inserts its four columns, and reads nothing.
  ['i', 'ops.api_events'],
  // 0048: the forwarder's kept alerts; the application holds nothing on them.
  ['', 'ops.api_alerts'],
  // 0069 (C55): the forwarder's alert log; the application selects its kind
  // and time columns alone, and changes nothing. A column grant: this suite's
  // `select 1` needs one column, and c55-security-alerts proves which.
  ['s', 'ops.security_alert_log'],
  ['s', 'ops.slots'],
  // The wayfinder's map read models (WF-1): their triggers write them; the app reads.
  ['s', 'map_frontier map_summaries'],
  // 0058 (S0-5): the installation's mode and the gate items are read by the
  // application through first_client_readiness().
  // 0059 (S0-5, ORCH38): the gate's own commands write through the app, so it
  // may insert a gate item, and update `mode` alone on the installation. A
  // column grant is not a table letter: this suite's update sets the first
  // column, which stays refused; s0-5-gate-commands proves the column.
  ['s', 'ops.installation'],
  ['si', 'ops.gate_items'],
  // 0061 (C58): an ended provider session, installation-wide; the application
  // inserts and reads its id column alone, and changes or removes nothing.
  ['si', 'ops.ended_provider_sessions'],
  // 0063 (C58): other sessions ended in every business, by subject digest.
  ['si', 'ops.ended_subject_sessions'],
  // 0064 (C59): a second factor verified or removed, by subject digest, for every business.
  ['si', 'ops.second_factor_subjects'],
  // 0072 (C59): a second-factor code sent or answered, by subject digest, for every business.
  ['si', 'ops.second_factor_codes'],
  ['si', 'audit_events authentication_attempts evidence_packs gate_decisions'],
  ['si', 'alerts handback_reports operations run_events'],
  // A map's versions are history; its components are retired by version, never deleted.
  ['si', 'map_versions'],
  ['siu', 'map_components'],
  // A run's checks, append only as handback_reports is (MP-6-1).
  ['si', 'run_checks'],
  // 0095 (MP-6-2): a run's state, each revision a version, never rewritten.
  ['si', 'run_states'],
  // 0092 (AW-03): a conversation, its body (deleted only by the purge, never
  // edited) and its wrap-ups (append only, never purged).
  ['siu', 'conversations'],
  ['sid', 'conversation_messages'],
  ['si', 'conversation_wrap_ups'],
  // AW-01: the model-call ledger, and the copy register, which is append only.
  ['siu', 'model_calls'],
  ['si', 'copy_registrations'],
  // AW-02: the pin and the read ledger are never rewritten; the audit copy is
  // kept and never read back by a run role.
  ['si', 'bootstrap_reads run_definition_pins'],
  ['i', 'bootstrap_bytes'],
  // AW-04: the plan a decision approved is bound once and never rewritten.
  ['si', 'plan_records'],
  // AW-04 (U10): a planning envelope is opened once and never moved.
  ['si', 'planning_envelopes'],
  // AW-08: a reviewed output is marked once, by its handback, and never rewritten.
  ['si', 'reviewed_outputs'],
  // AW-05: a budget ask is the persisted count and is never rewritten.
  ['si', 'budget_asks'],
  // AW-05: an answer and its approvals are never rewritten.
  ['si', 'budget_answers budget_approvals'],
  // AW-13: the export's cursor moves; its gaps are facts and never rewritten.
  ['siu', 'trace_export_cursors'],
  ['si', 'trace_export_gaps'],
  // AW-13: a retention batch is a fact, never rewritten.
  ['si', 'trace_expiry_batches'],
  // 0042: an attempt and a seen stamp are observations, never rewritten (INB-1a).
  ['si', 'inbox_attention inbox_delivery_attempts'],
  ['siu', 'inbox_items'],
  ['siu', 'actor_logins attempts budget_caps business_settings delegations gates grants'],
  ['siu', 'planned_steps proposal_lineages proposal_versions'],
  // AW-02 and SL11-30: a historical run and a lease's holder are never rewritten; the
  // application moves their states by COLUMN_UPDATES, and takes a lease by take_lease.
  ['si', 'planned_runs'],
  ['s', 'leases'],
  ['siu', 'outage_reports outage_runs reservations task_envelopes'],
  // 0049 (C59): a factor is written and moved on, never deleted.
  ['siu', 'second_factors'],
  // 0050 (C55): a privacy incident is recorded and moved on, never deleted.
  ['siu', 'privacy_incidents'],
  // 0051 (C81): a legal document version is drafted, then approved and
  // published by update; never deleted.
  ['siu', 'legal_document_versions'],
  // 0052 (C81): a row of the overseas-services register is set by insert or
  // update; never deleted.
  ['siu', 'overseas_services'],
  // 0053 (C81): a data class is set by insert or update; never deleted.
  ['siu', 'data_classes'],
  // 0054 (API-2): an agent credential is issued by insert and revoked by
  // update; never deleted.
  ['siu', 'agent_credentials'],
  // 0055 (C32): a client is written once and never deleted; C60 updates its
  // four privacy settings alone, by the column grant in COLUMN_UPDATES.
  ['si', 'clients'],
  // C60: a client's written request for model use is kept as written.
  ['si', 'client_model_requests'],
  // 0056 (C58): an access ending is written, then its provider steps are
  // stamped by update; never deleted.
  ['siu', 'access_endings'],
  // 0057 (C58): an ended session is written once; never changed or deleted.
  ['si', 'ended_sessions'],
  // 20261004175013 (C59): a factor reset is written, then its provider step is stamped by
  // update; never deleted.
  ['siu', 'factor_resets'],
  // 0065: the live change record, stamped by the writes' own triggers (C4);
  // the trash purge deletes a purged task's row.
  ['siud', 'live_changes'],
  // 0066: a person's own availability, set by them alone (MP-7-10).
  ['siu', 'person_availability'],
  // 0067: a second save of a key replaces its value; nothing deletes one (MP-2-11a).
  ['siu', 'person_preferences'],
  // 0078: a time entry is deleted by a mark; the trash purge detaches a
  // purged task's rows and keeps them (ORCH58).
  ['siu', 'time_entries'],
  // 0081: a tag stays in the vocabulary; a task's tag is a row deleted on removal.
  ['si', 'tags'],
  ['sid', 'task_tags'],
  ['siud', 'actors businesses field_defs logins memberships people person_identifiers'],
  // 0028 revokes delete on these two: identity history is kept (0002).
  ['siu', 'person_logins person_merges'],
  ['siud', 'record_links record_types record_unique_values'],
  ['siud', 'records'],
];

export const APPLICATION_GRANTS: Readonly<Record<string, string>> = Object.fromEntries(
  GRANT_GROUPS.flatMap(([granted, names]) =>
    names.split(' ').map((name) => [name.includes('.') ? name : `public.${name}`, granted]),
  ),
);

/**
 * Grants a later migration took back, so a prefix before it still holds them.
 * Keyed by table; the version is the first migration that no longer grants the
 * letters. 0028 revokes delete on identity history (R1-AUTHORITY-55).
 */
const REVOKED: Readonly<Record<string, { readonly from: string; readonly letters: string }>> = {
  'public.person_logins': { from: '0028', letters: 'd' },
  'public.person_merges': { from: '0028', letters: 'd' },
  // 0086 takes back update on the whole run and grants it on `state` alone.
  'public.planned_runs': { from: '0086', letters: 'u' },
  // 20261004040200 takes back insert and update on the whole lease and grants update by column.
  'public.leases': { from: '20261004040200', letters: 'iu' },
};

/**
 * Grants a later migration added, so a prefix before it does not hold them yet.
 * 0059 grants the gate's own insert (S0-5, ORCH38).
 */
const ADDED: Readonly<Record<string, { readonly from: string; readonly letters: string }>> = {
  'ops.gate_items': { from: '0059', letters: 'i' },
};

/**
 * What the application group holds on a table after the migration `at` (its
 * version, `0001_tenancy` and so on), or at the full schema when `at` is absent.
 */
export function applicationGrantsAt(qualified: string, at?: string): string | undefined {
  const granted = APPLICATION_GRANTS[qualified];
  if (granted === undefined || at === undefined) return granted;
  const version = at;
  const revoked = REVOKED[qualified];
  const added = ADDED[qualified];
  if (revoked !== undefined && version < revoked.from) return granted + revoked.letters;
  if (added !== undefined && version < added.from) return granted.replace(added.letters, '');
  return granted;
}

/** The functions the application group may execute. Every other one is refused to it. */
export const APPLICATION_EXECUTES: readonly string[] = [
  'public.app_business_id',
  'public.audit_event_hash',
  // 0058 (S0-5): security invoker, so it reads no more than the caller may.
  'public.first_client_readiness',
  // 20261004040200 (SL11-30): the pickup path, the one way a lease is written.
  'public.take_lease',
  // 20261004175013 (C59): a definer answering one boolean for a login of the caller's own
  // business; PUBLIC may not execute it.
  'public.factor_login_live_elsewhere',
];

/** What the server said, reduced to what a contract can name. */
export type Outcome =
  | { readonly kind: 'rows'; readonly n: number }
  | { readonly kind: 'denied' }
  | { readonly kind: 'rls' }
  | { readonly kind: 'constraint' }
  | { readonly kind: 'raised'; readonly message: string }
  | { readonly kind: 'trigger-only' }
  | { readonly kind: 'other'; readonly code: string; readonly message: string };

export function classify(error: unknown): Outcome {
  const code = String((error as { code?: unknown }).code ?? '');
  const message = error instanceof Error ? error.message : String(error);
  if (code === '42501' && /row-level security/u.test(message)) return { kind: 'rls' };
  if (code === '42501' && /permission denied/u.test(message)) return { kind: 'denied' };
  if (code.startsWith('23')) return { kind: 'constraint' };
  if (code === 'P0001') return { kind: 'raised', message };
  if (code === '0A000' && /only be called as triggers/u.test(message)) {
    return { kind: 'trigger-only' };
  }
  return { kind: 'other', code, message };
}

export const describeOutcome = (outcome: Outcome): string =>
  outcome.kind === 'rows'
    ? `rows ${String(outcome.n)}`
    : outcome.kind === 'other'
      ? `other ${outcome.code} ${outcome.message}`
      : outcome.kind;

export class Rollback extends Error {
  readonly rows: number;
  constructor(rows: number) {
    super('rolled back on purpose');
    this.rows = rows;
  }
}

export const asRole =
  (connection: AdminConnection, role?: string) =>
  async (text: string, parameters: readonly unknown[]): Promise<readonly unknown[]> =>
    await connection.transaction(async (execute) => {
      if (role !== undefined) await execute(`set local role ${role}`);
      return await execute(text, parameters);
    });
