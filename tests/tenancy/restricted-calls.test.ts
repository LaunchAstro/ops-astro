// SPDX-License-Identifier: AGPL-3.0-only
//
// I06 and M02 at the full schema: an actual select, insert, update and delete
// by every restricted caller against every table, and an actual call of every
// function, with the answer the contract expects asserted and the table's
// contents unchanged after every write.
//
// The world is the acceptance world: two businesses, the cast, and a journey
// walked through the real application to a handback, so the own business holds
// rows in the tables that matter and "the other tenant sees none" is asked of
// rows that exist. A table the journey leaves empty is named in the tally as
// empty, because filtering nothing proves less than filtering something.
//
// The per-prefix half is `restricted-calls-prefixes.test.ts`.

import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, serverUrl, type World } from '../acceptance/world.ts';
import {
  callModelOnTheJourney,
  walkTheJourney,
  walkTheOtherLineages,
} from '../acceptance/restart-harness.ts';
import { APPLICATION_ROLE } from '../support/fresh-database.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import {
  APPLICATION_EXECUTES,
  WORKER_ROLE,
  BROKER_ROLE,
  OCCURRENCE_ROLE,
  APPLICATION_GRANTS,
  classify,
  describeOutcome,
  type Outcome,
} from './restricted-calls-cases.ts';
import {
  catalogueFunctions,
  catalogueTables,
  type CatalogueFunction,
  type CatalogueTable,
} from './restricted-calls-catalogue.ts';
import {
  APPLICATION_CALLERS,
  OPERATIONS,
  callFor,
  copyRowFinding,
  copyStatement,
  expectedOutcome,
  fingerprint,
  meets,
  openCallers,
  ownRowJson,
  ownRows,
  statementFor,
  tally,
  type CallerName,
  type Callers,
} from './restricted-calls-callers.ts';
import { columnUpdateFindings } from './restricted-calls-columns.ts';
import { describeLiveCorrectionLows } from '../site/live-correction-lows.ts';
import { describeLiveCorrectionLowsRoundTwo } from '../site/live-correction-lows-2.ts';
import { describeLiveCorrectionSolRoundOne } from '../site/live-correction-lows-sol.ts';

/**
 * One owner-written row per business in the tables the journey leaves
 * empty, so their filtering is asked of rows that exist (TC:108). Written by
 * this suite's own setup rather than the shared world, so no other suite's
 * world assertions move.
 */
const UNREACHED: Readonly<Record<string, string>> = {
  // The journey holds no conversation (AW-03), so one row per business in each
  // of its three tables: the conversation owned by the business's first person
  // actor, its message and its wrap-up on that conversation, where the business
  // has them. Bravo's rows name ids that key nothing, written with foreign keys
  // off, as every seed here is.
  // WF-1: a map's body rows. Any record stands in for the map; the read-model
  // triggers find it is not one and write nothing.
  'public.map_components': `insert into public.map_components
       (business_id, id, map_id, kind, body, position, created_version)
     select business_id, gen_random_uuid(), id, 'fog', 'restricted calls seed', 0, 1
       from public.records where business_id = $1 order by id limit 1 returning 1`,
  'public.map_versions': `insert into public.map_versions
       (business_id, id, map_id, version, changed, actor_id)
     select r.business_id, gen_random_uuid(), r.id, 1, array[r.id], a.id
       from public.records r join public.actors a on a.business_id = r.business_id
      where r.business_id = $1 order by r.id, a.id limit 1 returning 1`,
  'public.conversations': `insert into public.conversations
       (business_id, id, owner_actor_id, owner_person_id, title)
     select $1, gen_random_uuid(), coalesce(a.id, gen_random_uuid()),
            coalesce(a.person_id, gen_random_uuid()), 'restricted calls seed'
       from (select 1) one
       left join lateral (
         select id, person_id from public.actors
          where business_id = $1 and person_id is not null order by id limit 1) a on true
     returning 1`,
  'public.conversation_messages': `insert into public.conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body)
     select $1, gen_random_uuid(), coalesce(c.id, gen_random_uuid()), 'person',
            coalesce(c.owner_actor_id, gen_random_uuid()), 'restricted calls seed'
       from (select 1) one
       left join lateral (
         select id, owner_actor_id from public.conversations
          where business_id = $1 order by id limit 1) c on true
     returning 1`,
  'public.conversation_wrap_ups': `insert into public.conversation_wrap_ups
       (business_id, id, conversation_id, version, written_by_operation, code_revision,
        request_quotation, items, left_open, activity_through)
     select $1, gen_random_uuid(), coalesce(c.id, gen_random_uuid()), 1, 'conversation.wrap_up',
            'seed', 'restricted calls seed', '[{},{},{},{},{},{},{}]'::jsonb, '[]'::jsonb, now()
       from (select 1) one
       left join lateral (
         select id from public.conversations where business_id = $1 order by id limit 1) c on true
     returning 1`,
  // The journey records no check (MP-6-1), so one is written against the
  // business's own lease, run, version and attempt where it has one, as
  // `recordCheck` does; Bravo holds no lease, so its row names ids that key
  // nothing. Written with foreign keys off, as every seed here is and as the prefixes
  // suite writes every reference row.
  // The journey revises no run's state (MP-6-2): one version on the business's
  // first run, where it has one; otherwise ids that key nothing.
  'public.run_states': `insert into public.run_states
       (business_id, id, run_id, task_id, version, knowledge, unknowns, revised_by_actor_id)
     select $1, gen_random_uuid(), coalesce(r.id, gen_random_uuid()),
            coalesce(r.task_id, gen_random_uuid()), 1, '["restricted calls seed"]', '[]',
            coalesce(a.id, gen_random_uuid())
       from (select 1) one
       left join lateral (
         select id, task_id from public.planned_runs where business_id = $1 order by id limit 1) r on true
       left join lateral (
         select id from public.actors where business_id = $1 order by id limit 1) a on true
     returning 1`,
  'public.run_checks': `insert into public.run_checks
       (business_id, id, task_id, run_id, version_id, lease_id, attempt_id, actor_id,
        fence, name, outcome)
     select $1, gen_random_uuid(), coalesce(w.task_id, gen_random_uuid()),
            coalesce(w.run_id, gen_random_uuid()), coalesce(w.version_id, gen_random_uuid()),
            coalesce(w.lease_id, gen_random_uuid()), coalesce(w.attempt_id, gen_random_uuid()),
            coalesce(w.actor_id, gen_random_uuid()), coalesce(w.fence, 1),
            'restricted calls seed', 'passed'
       from (select 1) one
       left join lateral (
         select l.task_id, run.id as run_id, run.version_id, l.id as lease_id,
                att.id as attempt_id, l.holder_actor_id as actor_id, l.fence
           from public.leases l
           join public.reservations res on res.business_id = l.business_id and res.lease_id = l.id
           join public.planned_runs run on run.business_id = res.business_id and run.id = res.run_id
           join public.attempts att on att.business_id = res.business_id and att.reservation_id = res.id
          where l.business_id = $1
          order by l.id limit 1) w on true
     returning 1`,
  'public.person_identifiers': `insert into public.person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system)
     select business_id, gen_random_uuid(), id, 'email', 'restricted-calls-seed',
            'restricted-calls-seed', 'restricted_calls'
       from public.people where business_id = $1 order by id limit 1 returning 1`,
  // A business in the world holds one person, so the absorbed one is written here.
  'public.person_merges': `with absorbed as (
       insert into public.people (business_id, id, display_name)
       values ($1, gen_random_uuid(), 'restricted calls absorbed') returning business_id, id)
     insert into public.person_merges
       (business_id, id, surviving_person_id, absorbed_person_id, decided_by_actor_id, evidence)
     select a.business_id, gen_random_uuid(), p.id, a.id, actor.id, 'restricted_calls seed'
       from absorbed a
       join public.people p on p.business_id = a.business_id
       join public.actors actor on actor.business_id = a.business_id
      order by p.id, actor.id limit 1 returning 1`,
  // C59: no journey enrols a second factor, so one is written here.
  'public.second_factors': `insert into public.second_factors
       (business_id, id, person_id, provider, provider_factor_id)
     select business_id, gen_random_uuid(), id, 'supabase', 'restricted-calls-seed'
       from public.people where business_id = $1 order by id limit 1 returning 1`,
  // C55: no journey records a privacy incident, so one is written here.
  'public.privacy_incidents': `insert into public.privacy_incidents
       (business_id, id, what_happened, found_at, found_by, affected, information_kinds,
        recorded_by_actor)
     select business_id, gen_random_uuid(), 'restricted calls seed', now(), 'seed', 'nobody',
            array['other'], id
       from public.actors where business_id = $1 order by id limit 1 returning 1`,
  // C81: no journey drafts a legal document version, so one is written here.
  'public.legal_document_versions': `insert into public.legal_document_versions
       (business_id, id, document, version, body, body_digest, drafted_by_actor)
     select business_id, gen_random_uuid(), 'breach-runbook', '0.1', 'restricted calls seed', '',
            id
       from public.actors where business_id = $1 order by id limit 1 returning 1`,
  // C81: no journey sets a register row, so one is written here.
  'public.overseas_services': `insert into public.overseas_services
       (business_id, id, service, receives, stored_where, trains_on_it, contract, to_confirm,
        in_use, updated_by_actor)
     select business_id, gen_random_uuid(), 'restricted calls seed', 'nothing', 'nowhere', 'no',
            'none', false, true, id
       from public.actors where business_id = $1 order by id limit 1 returning 1`,
  // C81: no journey sets a data class, so one is written here.
  'public.data_classes': `insert into public.data_classes
       (business_id, id, data_class, purpose, disclosures, retention, deletion, in_use,
        updated_by_actor)
     select business_id, gen_random_uuid(), 'restricted calls seed', 'nothing', 'no one',
            'a day', 'deleted', true, id
       from public.actors where business_id = $1 order by id limit 1 returning 1`,
  // API-2: no journey issues an agent credential, so one is written here.
  'public.agent_credentials': `insert into public.agent_credentials
       (business_id, id, agent_actor_id, issued_by_person_id, issued_by_actor_id, purpose, scope,
        credential_hash, credential_scheme, credential_key_id, expires_at)
     select business_id, gen_random_uuid(), id, person_id, id, 'restricted calls seed',
            array['task:read'], repeat('0', 64), 'hmac-sha256-v1', 'seed', now() + interval '1 day'
       from public.actors where business_id = $1 and kind = 'person'
      order by id limit 1 returning 1`,
  // C32: no journey makes a client, so one is written here.
  'public.clients': `insert into public.clients (business_id, id, name, created_by_actor_id)
     select business_id, gen_random_uuid(), 'restricted calls seed', id
       from public.actors where business_id = $1 order by id limit 1 returning 1`,
  // C60: no journey records a client's written request, so one is written here.
  'public.client_model_requests': `insert into public.client_model_requests
       (business_id, id, client_id, requested_by, requested_on, request_link, providers, outcome,
        recorded_by_actor)
     select business_id, gen_random_uuid(), id, 'restricted calls seed', current_date,
            'https://files.example.test/seed.pdf', array['replay'], 'applied', created_by_actor_id
       from public.clients where business_id = $1 order by id limit 1 returning 1`,
  // C58: no journey ends a person's access, so an ending is written here for a
  // person's own login, as `access.end` writes one.
  'public.access_endings': `insert into public.access_endings
       (business_id, person_id, login_id, ended_by_actor_id)
     select pl.business_id, pl.person_id, pl.login_id, a.id
       from public.person_logins pl
       join public.actors a on a.business_id = pl.business_id and a.person_id = pl.person_id
      where pl.business_id = $1 order by pl.login_id limit 1 returning 1`,
  // C58: an ended session, as signing out writes one for a person's own session.
  'public.ended_sessions': `insert into public.ended_sessions
       (business_id, person_id, session_id, reason)
     select business_id, id, gen_random_uuid(), 'sign_out'
       from public.people where business_id = $1 order by id limit 1 returning 1`,
  'public.record_links': `insert into public.record_links
       (business_id, id, link_type, from_record_id, to_record_id)
     select a.business_id, gen_random_uuid(), 'restricted_calls', a.id, b.id
       from public.records a
       join public.records b on b.business_id = a.business_id and b.id > a.id
      where a.business_id = $1 order by a.id, b.id limit 1 returning 1`,
  // T3e2: the journey drops nothing, so one report and one of its runs.
  'public.outage_reports': `insert into public.outage_reports (business_id, id, cause)
     values ($1, gen_random_uuid(), 'worker_lost') returning 1`,
  // C80's two tables: the journey requests no live correction. The receipt
  // follows the correction, on a lease the journey left in the same business.
  'public.live_corrections': `insert into public.live_corrections
       (business_id, id, party_id, task_id, requested_by_actor_id, requested_by_person_id,
        target_path, word, replacement, page_url, pre_image_digest, base_revision, seam,
        version_id, version_digest)
     select p.business_id, gen_random_uuid(), gen_random_uuid(), r.id, a.id, p.id,
            'src/pages/about.md', 'friendly', 'welcoming', 'https://agency.example/about/',
            'sha256:seed', 'rev-1', 'seam-seed', gen_random_uuid(), 'sha256:seed'
       from public.people p
       join public.actors a on a.business_id = p.business_id
       join public.records r on r.business_id = p.business_id
      where p.business_id = $1 order by p.id, a.id, r.id limit 1 returning 1`,
  'public.live_correction_receipts': `insert into public.live_correction_receipts
       (business_id, id, correction_id, lease_id, fence, step, outcome, observations)
     select c.business_id, gen_random_uuid(), c.id, coalesce(l.id, gen_random_uuid()),
            coalesce(l.fence, 1), 'publish', 'live', '{}'::jsonb
       from public.live_corrections c
       left join lateral (select id, fence from public.leases
                           where business_id = c.business_id order by id limit 1) l on true
      where c.business_id = $1 order by c.id limit 1 returning 1`,
  // AW-01: the copy register, which the journey never reaches.
  'public.copy_registrations': `insert into public.copy_registrations
       (business_id, id, copy_class, copy_key, invalidation_trigger, retention_class)
     values ($1, gen_random_uuid(), 'outbound_prompt', 'model_call:' || gen_random_uuid(),
             'call_ended', 'transient') returning 1`,
  // AW-02: nothing writes a pin before AW-04's plan accept. The pin rides on
  // a run the journey made; a business with none gets a made-up run id, which
  // the owner's seed writes with foreign keys off.
  'public.run_definition_pins': `insert into public.run_definition_pins
       (business_id, run_id, ref_kind, path, content_digest, content_size, read_at,
        manifest, manifest_digest, pinned_by_actor_id)
     select $1,
            coalesce((select id from public.planned_runs where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            'bootstrap_file', 'skills/seed.md', encode(sha256('seed'::bytea), 'hex'), 4, now(),
            '[]'::jsonb, encode(sha256('seed'::bytea), 'hex'),
            coalesce((select id from public.actors where business_id = $1 order by id limit 1),
                     gen_random_uuid())
     returning 1`,
  // AW-04: nothing binds a plan before a plan accept. The row rides on a
  // decision the journey made; a business with none gets made-up ids, which
  // the owner's seed writes with foreign keys off.
  'public.plan_records': `insert into public.plan_records
       (business_id, id, gate_id, decision_id, run_id, plan_text, text_digest, record,
        record_digest, bound_by_actor_id)
     select $1, gen_random_uuid(),
            coalesce(d.gate_id, gen_random_uuid()), coalesce(d.id, gen_random_uuid()),
            coalesce(g.run_id, gen_random_uuid()), 'seed', encode(sha256('seed'::bytea), 'hex'),
            '{"steps": []}'::jsonb, encode(sha256('seed'::bytea), 'hex'),
            coalesce((select id from public.actors where business_id = $1 order by id limit 1),
                     gen_random_uuid())
       from (select 1) one
       left join public.gate_decisions d on d.business_id = $1
             and d.id = (select id from public.gate_decisions where business_id = $1
                          order by id limit 1)
       left join public.gates g on g.business_id = d.business_id and g.id = d.gate_id
     returning 1`,
  // AW-08: the mark rides on a lease the journey made and a version newer than
  // its work on its run's lineage, proposed by its holder (0108, 0111), which the
  // owner writes beside it, superseded, since the journey hands nothing back. A
  // business with none gets made-up ids, written with foreign keys off.
  'public.reviewed_outputs': `with picked as (
       select l.id as lease_id, l.holder_actor_id, r.lineage_id from public.leases l
         join public.planned_runs r on r.business_id = l.business_id and r.id = l.run_id
        where l.business_id = $1 order by l.id limit 1),
     newer as (
       insert into public.proposal_versions (business_id, id, lineage_id, version, payload,
              payload_digest, purpose, maximum_minor, currency, proposed_by_actor_id,
              superseded_at)
       select v.business_id, gen_random_uuid(), v.lineage_id, v.version + 1, v.payload,
              v.payload_digest, v.purpose, v.maximum_minor, v.currency,
              p.holder_actor_id, now()
         from picked p join public.proposal_versions v
           on v.business_id = $1 and v.lineage_id = p.lineage_id
        order by v.version desc limit 1
       returning id, lineage_id)
     insert into public.reviewed_outputs (business_id, version_id, lineage_id, lease_id)
     select $1, coalesce(n.id, gen_random_uuid()), coalesce(n.lineage_id, gen_random_uuid()),
            coalesce(p.lease_id, gen_random_uuid())
       from (select 1) one left join picked p on true left join newer n on true
     returning 1`,
  // AW-04 (U10): no planning reply is priced before a cap is set. The row
  // rides on the business's first cap and person; a business with none gets
  // made-up ids, which the owner's seed writes with foreign keys off.
  'public.planning_envelopes': `insert into public.planning_envelopes
       (business_id, id, cap_id, conversation_id, owner_person_id)
     select $1, gen_random_uuid(),
            coalesce((select id from public.budget_caps where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            gen_random_uuid(),
            coalesce((select id from public.people where business_id = $1 order by id limit 1),
                     gen_random_uuid())
     returning 1`,
  'public.bootstrap_reads': `insert into public.bootstrap_reads
       (business_id, id, run_id, sequence, path, content_digest, content_size, is_entry)
     select p.business_id, gen_random_uuid(), p.run_id, 1, p.path, p.content_digest,
            p.content_size, true
       from public.run_definition_pins p where p.business_id = $1 order by p.run_id limit 1
     returning 1`,
  // AW-05: an ask stands on a lease the journey made, with its run and
  // reservation, and a decision; a business with none gets made-up ids, which
  // the owner's seed writes with foreign keys off.
  'public.budget_asks': `insert into public.budget_asks
       (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
        ceiling_minor, spent_minor, currency)
     select $1, gen_random_uuid(),
            coalesce((select run_id from public.leases where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            coalesce((select reservation_id from public.leases where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            coalesce((select id from public.leases where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            coalesce((select id from public.gate_decisions where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            1, 'stop', 400, 0, 'AUD'
     returning 1`,
  // AW-05: an answer stands on an ask the journey raised, with its run and a
  // person and actor of the business; a business with none gets made-up ids,
  // which the owner's seed writes with foreign keys off.
  'public.budget_approvals': `insert into public.budget_approvals
       (business_id, id, ask_id, run_id, person_id, actor_id, amount_minor, currency)
     select $1, gen_random_uuid(),
            coalesce((select id from public.budget_asks where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            coalesce((select run_id from public.budget_asks where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            coalesce((select id from public.people where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            coalesce((select id from public.actors where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            300, 'AUD'
     returning 1`,
  'public.budget_answers': `insert into public.budget_answers
       (business_id, id, ask_id, run_id, kind, first_person_id)
     select $1, gen_random_uuid(),
            coalesce((select id from public.budget_asks where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            coalesce((select run_id from public.budget_asks where business_id = $1 order by id limit 1),
                     gen_random_uuid()),
            'end',
            coalesce((select id from public.people where business_id = $1 order by id limit 1),
                     gen_random_uuid())
     returning 1`,
  // AW-13: nothing starts the exporter on the journey.
  'public.trace_export_cursors': `insert into public.trace_export_cursors (business_id)
     values ($1) returning 1`,
  'public.trace_export_gaps': `insert into public.trace_export_gaps
       (business_id, id, code, events)
     values ($1, gen_random_uuid(), 'target_unreachable', 1) returning 1`,
  'public.trace_expiry_batches': `insert into public.trace_expiry_batches
       (business_id, id, window_days, runs, expired_run_ids)
     values ($1, gen_random_uuid(), 30, 1, array[gen_random_uuid()]) returning 1`,
  'public.bootstrap_bytes': `insert into public.bootstrap_bytes
       (business_id, content_digest, content_size, bytes)
     values ($1, encode(sha256('seed'::bytea), 'hex'), 4, 'seed'::bytea) returning 1`,
  // Nothing in the journey saves a preference (MP-2-11a adds the command).
  'public.person_preferences': `insert into public.person_preferences
       (business_id, person_id, key, value)
     select business_id, id, 'appearance', '"dark"'::jsonb from public.people
      where business_id = $1 order by id limit 1 returning 1`,
  // 0043: set by a person in the Team panel (MP-7-10), which the journey never opens.
  'public.person_availability': `insert into public.person_availability
       (business_id, person_id, state, reason)
     select business_id, id, 'away', 'restricted calls seed'
       from public.people where business_id = $1 order by id limit 1 returning 1`,
  // 20261005004230: nothing in the journey opens a team conversation (C71-D); the member
  // row names a record and a person of the business.
  'public.team_conversation_members': `insert into public.team_conversation_members
       (business_id, conversation_id, person_id)
     select r.business_id, r.id, p.id
       from public.records r join public.people p on p.business_id = r.business_id
      where r.business_id = $1 order by r.id, p.id limit 1 returning 1`,
  // Nothing in the journey raises an inbox item yet (INB-1b does), so one item,
  // its recipient's attention row and one attempt are written here, in order.
  'public.inbox_items': `insert into public.inbox_items
       (business_id, id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id)
     select r.business_id, gen_random_uuid(), p.id, r.id, 'assignment', 'record', r.id
       from public.records r join public.people p on p.business_id = r.business_id
      where r.business_id = $1 order by r.id, p.id limit 1 returning 1`,
  'public.inbox_attention': `insert into public.inbox_attention (business_id, item_id, person_id)
     select business_id, id, recipient_person_id from public.inbox_items
      where business_id = $1 order by id limit 1 returning 1`,
  'public.inbox_delivery_attempts': `insert into public.inbox_delivery_attempts
       (business_id, id, item_id, channel, state)
     select business_id, gen_random_uuid(), id, 'in_app', 'asked' from public.inbox_items
      where business_id = $1 order by id limit 1 returning 1`,
};

/**
 * T3e2: an outage run names an attempt, and only the own business's journey
 * makes one, so this seed is the own business's alone.
 */
const UNREACHED_OWN: Readonly<Record<string, string>> = {
  'public.outage_runs': `insert into public.outage_runs
       (business_id, outage_id, attempt_id, run_id, task_id, reactivated)
     select r.business_id, r.id, att.id, run.id, run.task_id, false
       from public.outage_reports r
       join public.attempts att on att.business_id = r.business_id
       join public.planned_runs run on run.business_id = att.business_id and run.id = att.run_id
      where r.business_id = $1 order by att.id limit 1 returning 1`,
  // 0078: no journey step logs time yet, so one finished entry is written here.
  'public.time_entries': `insert into public.time_entries
       (business_id, id, task_id, person_id, actor_id, started_at, ended_at, minutes,
        ad_hoc, source)
     select r.business_id, gen_random_uuid(), r.id, p.id, a.id, now(), now(), 1, false, 'log'
       from public.records r
       join public.people p on p.business_id = r.business_id
       join public.actors a on a.business_id = r.business_id
      where r.business_id = $1 order by r.id, p.id, a.id limit 1 returning 1`,
  // 0081: no journey step tags a task yet, so one tag is named here...
  'public.tags': `insert into public.tags (business_id, id, name, actor_id)
     select a.business_id, gen_random_uuid(), 'restricted ' || left(gen_random_uuid()::text, 8), a.id
       from public.actors a
      where a.business_id = $1 order by a.id limit 1 returning 1`,
  // ...and one task carries a tag of its own, made in the same statement.
  'public.task_tags': `with made as (
       insert into public.tags (business_id, id, name, actor_id)
       select a.business_id, gen_random_uuid(), 'carried ' || left(gen_random_uuid()::text, 8), a.id
         from public.actors a
        where a.business_id = $1 order by a.id limit 1
       returning business_id, id, actor_id)
     insert into public.task_tags (business_id, task_id, tag_id, actor_id)
     select m.business_id, r.id, m.id, m.actor_id
       from made m
       join public.records r on r.business_id = m.business_id
      order by r.id limit 1 returning 1`,
};

/** Thrown to end the wrapper's transaction once the insert has answered. */
class RolledBack extends Error {
  readonly n: number;
  constructor(n: number) {
    super('rolled back');
    this.n = n;
  }
}

const TABLE_CALLERS: readonly CallerName[] = [
  'login in the wrapper, own tenant',
  'login in the wrapper, other tenant',
  'login outside the wrapper',
  'application group outside the wrapper',
  'outsider in the wrapper',
  'outsider outside the wrapper',
  'worker',
];

/**
 * Every role on the cluster that is not the server's own, sorted into the
 * classes a call is made for. A role that fits none of them is returned as
 * `unclassified` and the suites fail on it: a role nobody decided about is the
 * one this proof exists for.
 */
async function roleClasses(
  admin: AdminConnection,
): Promise<Readonly<Record<string, readonly string[]>>> {
  const rows = await admin.execute<{ rolname: string; class: string }>(
    `select r.rolname,
            case when r.rolsuper then 'owner'
                 when r.rolname = $1 then 'application group'
                 when pg_has_role(r.rolname, $1, 'member') then 'application login'
                 when r.rolname = $2 then 'worker'
                 when r.rolname = $3 then 'broker'
                 when r.rolname = $4 then 'occurrence'
                 when r.rolname = 'ops_astro_backup' then 'backup'
                 when r.rolname = 'ops_astro_backup_retention' then 'backup retention'
                 when r.rolname = 'ops_astro_backup_restore' then 'backup restore'
                 when r.rolname = 'ops_astro_lookup' then 'lookup'
                 when r.rolname = 'ops_astro_forwarder' then 'forwarder'
                 when r.rolname = 'ops_astro_restore_drill' then 'restore drill'
                 when r.rolname = 'ops_astro_upkeep' then 'upkeep'
                 when r.rolname = 'ops_astro_lease_path' then 'lease path'
                 when r.rolcanlogin and not r.rolbypassrls and not r.rolcreaterole
                      and not r.rolcreatedb then 'outsider'
                 else 'unclassified' end as class
       from pg_roles r where r.rolname !~ '^pg_' order by 1`,
    [APPLICATION_ROLE, WORKER_ROLE, BROKER_ROLE, OCCURRENCE_ROLE],
  );
  const classes: Record<string, string[]> = {};
  for (const row of rows) (classes[row.class] ??= []).push(row.rolname);
  return classes;
}

/**
 * The security definer functions, by signature. WF-1 added the map read
 * models' four writers, so the summary and frontier tables have one writer and
 * the application only reads them.
 */
const DEFINERS: readonly string[] = [
  'handback_reports_append_only()',
  'map_summary_on_link()',
  'map_summary_on_map_part()',
  'map_summary_on_record()',
  'map_summary_refresh(uuid)',
  'model_route_room(text,integer)',
  'ops.ended_subject_sessions_at_commit()',
  'ops.expire_second_factor_codes()',
  'ops.record_tested_restore()',
  'take_lease(uuid,uuid,uuid,uuid,uuid,timestamp with time zone,text)',
];

describe.skipIf(serverUrl === undefined)('I06/M02: restricted calls at the full schema', () => {
  let world: World;
  let callers: Callers;
  let tables: readonly CatalogueTable[];
  let functions: readonly CatalogueFunction[];
  const executed: string[] = [];

  beforeAll(async () => {
    world = await createWorld('rcf');
    await walkTheOtherLineages(world);
    const walked = await walkTheJourney(world);
    await callModelOnTheJourney(world, walked);
    for (const business of [world.alpha, world.bravo]) {
      for (const [table, text] of Object.entries(UNREACHED)) {
        // oxlint-disable-next-line no-await-in-loop
        const seeded = await world.db.admin.transaction(async (execute) => {
          await execute('set local session_replication_role = replica');
          return await execute(text, [business]);
        });
        if (seeded.length !== 1) throw new Error(`no seed row for ${table}`);
      }
    }
    for (const [table, text] of Object.entries(UNREACHED_OWN)) {
      // oxlint-disable-next-line no-await-in-loop
      const seeded = await world.db.admin.execute(text, [world.alpha]);
      if (seeded.length !== 1) throw new Error(`no seed row for ${table}`);
    }
    callers = openCallers(world.db, { own: world.alpha, other: world.bravo });
    tables = await catalogueTables(world.db.admin);
    functions = await catalogueFunctions(world.db.admin);
  }, 180_000);

  afterAll(async () => {
    tally('0020 full', executed);
    await callers?.close();
    await world?.close();
  });

  // Every migration on disk, read from the directory rather than counted here,
  // so the next migration needs no edit to this suite (docs/local/DATA.md, "What the schema is").
  it('reads every migration on disk, and a table set the contract names exactly', async () => {
    const applied = await world.db.admin.execute<{ version: string }>(
      'select version from ops.schema_migrations order by version',
    );
    expect(applied.map((row) => `${row.version}.sql`)).toStrictEqual(
      readdirSync('migrations')
        .filter((name) => name.endsWith('.sql'))
        .toSorted(),
    );
    expect(tables.map((table) => table.qualified)).toStrictEqual(
      Object.keys(APPLICATION_GRANTS).toSorted(),
    );
    expect(tables.filter((table) => table.kind !== 'r')).toStrictEqual([]);
    for (const table of tables.filter((each) => each.tenant)) {
      expect({ table: table.qualified, forced: table.forced }).toStrictEqual({
        table: table.qualified,
        forced: true,
      });
    }
  });

  it('sorts every role on the cluster into a class a call is made for', async () => {
    const classes = await roleClasses(world.db.admin);
    expect(classes['unclassified'] ?? []).toStrictEqual([]);
    expect(classes['application group']).toStrictEqual([APPLICATION_ROLE]);
    expect(classes['worker']).toStrictEqual(['ops_astro_worker']);
    expect(classes['broker']).toStrictEqual([BROKER_ROLE]);
    expect(classes['occurrence']).toStrictEqual([OCCURRENCE_ROLE]);
    // S0-3b: the backup identity reads and is proved in tests/db/backup-identity.test.ts.
    expect(classes['backup']).toStrictEqual(['ops_astro_backup']);
    // G2: the business lookup reads id and key of businesses, proved in tests/db/business-lookup.test.ts.
    expect(classes['lookup']).toStrictEqual(['ops_astro_lookup']);
    // S0-2: the outbox forwarder reads and deletes ops.api_events and keeps its raised alerts in
    // ops.api_alerts (0048), proved in tests/db/api-events.test.ts.
    expect(classes['forwarder']).toStrictEqual(['ops_astro_forwarder']);
    // C55: the restore drill stamps the date of the last tested restore through
    // ops.record_tested_restore() (0070), proved in tests/operations/c55-last-tested-restore.test.ts.
    expect(classes['restore drill']).toStrictEqual(['ops_astro_restore_drill']);
    // 20261002105957: the daily upkeep deletes second-factor codes past their horizon through
    // ops.expire_second_factor_codes(), proved in tests/db/second-factor-codes-retention.test.ts.
    expect(classes['upkeep']).toStrictEqual(['ops_astro_upkeep']);
    // 20261004040200: the pickup path's role owns public.take_lease and inserts leases under row security,
    // proved in tests/db/take-lease-path.test.ts.
    expect(classes['lease path']).toStrictEqual(['ops_astro_lease_path']);
    expect(classes['application login']).toContain(world.db.loginRole);
    expect(classes['outsider']).toContain(world.db.restrictedRole);
  });

  it('answers every caller on every table as the contract says, and no write lands', async () => {
    const wrong: string[] = [];
    for (const table of tables) {
      // oxlint-disable-next-line no-await-in-loop
      const own = await ownRows(world.db.admin, table, world.alpha);
      for (const operation of OPERATIONS) {
        const text = statementFor(table, operation);
        for (const caller of TABLE_CALLERS) {
          // One statement at a time: each answer is read against the state
          // the one before it left, and a write that landed would move it.
          // oxlint-disable-next-line no-await-in-loop
          const before = await fingerprint(world.db.admin, table.qualified);
          // oxlint-disable-next-line no-await-in-loop
          const outcome = await callers.call(caller, text, table.tenant ? [world.alpha] : []);
          // oxlint-disable-next-line no-await-in-loop
          const after = await fingerprint(world.db.admin, table.qualified);
          const expected = expectedOutcome(caller, table, operation, own);
          const line = `${table.qualified}\t${operation}\t${caller}\t${describeOutcome(outcome)}\town=${String(own)}`;
          executed.push(line);
          if (!meets(expected, outcome)) wrong.push(`${line}\texpected ${expected}`);
          if (before !== after) wrong.push(`${line}\tthe table changed`);
        }
      }
    }
    expect(wrong).toStrictEqual([]);
    expect(executed.length).toBe(tables.length * OPERATIONS.length * TABLE_CALLERS.length);
  }, 120_000);

  it('grants update column by column only as the contract says, and answers every caller on it', async () => {
    const wrong = await columnUpdateFindings(world.db.admin, callers, TABLE_CALLERS, world.alpha);
    expect(wrong).toStrictEqual([]);
  });

  it('refuses a whole own-business row re-sent by every other caller, and it does not land', async () => {
    const wrong: string[] = [];
    let copied = 0;
    for (const table of tables.filter((each) => each.tenant)) {
      // oxlint-disable-next-line no-await-in-loop
      const row = await ownRowJson(world.db.admin, table, world.alpha);
      if (row === undefined) continue;
      const finding = copyRowFinding(table, row);
      if (finding !== undefined) {
        wrong.push(`${table.qualified}\tinsert copy\t${finding}`);
        continue;
      }
      copied += 1;
      for (const caller of TABLE_CALLERS.slice(1)) {
        // oxlint-disable-next-line no-await-in-loop
        const before = await fingerprint(world.db.admin, table.qualified);
        // oxlint-disable-next-line no-await-in-loop
        const outcome = await callers.call(caller, copyStatement(table), [row]);
        // oxlint-disable-next-line no-await-in-loop
        const after = await fingerprint(world.db.admin, table.qualified);
        const expected = expectedOutcome(caller, table, 'insert', 0, undefined, true);
        const line = `${table.qualified}\tinsert copy\t${caller}\t${describeOutcome(outcome)}`;
        executed.push(line);
        if (!meets(expected, outcome)) wrong.push(`${line}\texpected ${expected}`);
        if (before !== after) wrong.push(`${line}\tthe table changed`);
      }
    }
    expect(wrong).toStrictEqual([]);
    expect(copied).toBeGreaterThan(0);
  }, 120_000);

  it('holds rows for the own business in the tables the journey reaches', async () => {
    const empty: string[] = [];
    for (const table of tables) {
      // oxlint-disable-next-line no-await-in-loop
      if ((await ownRows(world.db.admin, table, world.alpha)) === 0) empty.push(table.qualified);
    }
    tally('0020 full empty', empty);
    // Recorded rather than required: the tally names every table whose
    // filtering was asked of no rows. The tables the definer guards are not
    // among them, because that case below needs a row to refuse.
    expect(empty).not.toContain('public.handback_reports');
    expect(empty).not.toContain('public.records');
    for (const table of [...Object.keys(UNREACHED), ...Object.keys(UNREACHED_OWN)]) {
      expect(empty).not.toContain(table);
    }
  });

  it('admits an own-business insert on every table the application inserts into', async () => {
    // The positive control TC:108 names, counted: the login, through the
    // production wrapper in its own tenant, inserts a whole own row and the
    // insert lands. The owner first sets that row aside with triggers and
    // foreign keys off, so the table's own uniqueness does not answer instead;
    // the wrapper's transaction is rolled back, and the owner puts the row
    // back exactly, which the fingerprint shows.
    const inserting = tables.filter(
      (table) => table.tenant && (APPLICATION_GRANTS[table.qualified] ?? '').includes('i'),
    );
    const admitted: string[] = [];
    const wrong: string[] = [];
    const asOwner = async (text: string, row: string): Promise<number> =>
      await world.db.admin.transaction(async (execute) => {
        await execute('set local session_replication_role = replica');
        return (await execute(text, [row])).length;
      });
    for (const table of inserting) {
      // oxlint-disable-next-line no-await-in-loop
      const row = await ownRowJson(world.db.admin, table, world.alpha);
      if (row === undefined) {
        wrong.push(`${table.qualified}\tno own row to insert`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      const before = await fingerprint(world.db.admin, table.qualified);
      // oxlint-disable-next-line no-await-in-loop
      const aside = await asOwner(
        `delete from ${table.qualified} t where row_to_json(t)::text = $1 returning 1`,
        row,
      );
      let outcome: Outcome;
      try {
        // oxlint-disable-next-line no-await-in-loop
        await world.db.app.withBusiness(world.alpha, async (tx) => {
          throw new RolledBack((await tx.query(copyStatement(table), [row])).length);
        });
        outcome = { kind: 'other', code: '', message: 'committed' };
      } catch (error) {
        outcome = error instanceof RolledBack ? { kind: 'rows', n: error.n } : classify(error);
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await asOwner(copyStatement(table), row);
      }
      // oxlint-disable-next-line no-await-in-loop
      const after = await fingerprint(world.db.admin, table.qualified);
      const line = `${table.qualified}\town insert\tlogin in the wrapper, own tenant\t${describeOutcome(outcome)}`;
      admitted.push(line);
      if (aside !== 1) wrong.push(`${line}\tset aside ${String(aside)} rows`);
      if (describeOutcome(outcome) !== 'rows 1') wrong.push(`${line}\texpected rows 1`);
      if (before !== after) wrong.push(`${line}\tthe table changed`);
    }
    executed.push(...admitted);
    tally('0020 own insert', admitted);
    expect(wrong).toStrictEqual([]);
    expect(admitted).toHaveLength(inserting.length);
    expect(inserting.length).toBeGreaterThan(0);
  }, 120_000);

  it('calls every function as every caller, and only the granted four run', async () => {
    const wrong: string[] = [];
    for (const fn of functions) {
      for (const caller of [...TABLE_CALLERS, 'owner'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const outcome = await callers.call(caller, callFor(fn));
        const application = caller !== 'owner' && APPLICATION_CALLERS.has(caller);
        const expected =
          caller === 'owner' || (application && APPLICATION_EXECUTES.includes(fn.qualified))
            ? fn.trigger
              ? 'trigger-only'
              : 'rows 1'
            : 'denied';
        const line = `${fn.signature}\tcall\t${caller}\t${describeOutcome(outcome)}`;
        executed.push(line);
        if (describeOutcome(outcome) !== expected) wrong.push(`${line}\texpected ${expected}`);
      }
    }
    expect(wrong).toStrictEqual([]);
  });

  // Ten, each for a named reason. The map read models' four (WF-1) and the
  // pickup path (take_lease) are pinned in their own blocks below. The append-only trigger refuses
  // the owner itself. The fair share's count (AW-01, ORCH-DECISION SL11
  // AW-01) is the one read across businesses: a provider route's ceiling is
  // the installation's, which a tenant transaction cannot count under row
  // security. It answers one number and no id, and only the broker's role
  // may execute it (tests/broker/aw-01-broker-fair-share.test.ts). The drill
  // stamp (C55) writes only now(), and only the drill's identity runs it. The
  // codes expiry (20261002105957) deletes only rows past its fixed horizon, and only the
  // upkeep identity runs it. The ending's commit time (20261004181806) is a
  // trigger on the subject-wide endings that only moves a new row's time later.
  // The pickup path (SL11-30, 20261004040200) is the one way a lease is
  // written, in the caller's own business (tests/db/take-lease-path.test.ts).
  describe('the security definer functions', () => {
    const definers = (): readonly CatalogueFunction[] => functions.filter((fn) => fn.definer);
    const definer = (signature: string): CatalogueFunction | undefined =>
      definers().find((fn) => fn.signature === signature);

    it('are exactly ten, each with its search path pinned', () => {
      expect(definers().map((fn) => fn.signature)).toStrictEqual(DEFINERS);
    });

    it('the first is a trigger on handback_reports', () => {
      const fn = definer('handback_reports_append_only()');
      expect(fn?.trigger).toBe(true);
      expect(fn?.config).toStrictEqual(['search_path=pg_catalog, public']);
      expect(fn?.firedBy).toStrictEqual([
        { table: 'public.handback_reports', events: 'delete update' },
      ]);
    });

    it("the second is the fair share's count, fired by nothing and pinned to read every business", () => {
      const fn = definer('model_route_room(text,integer)');
      expect(fn?.trigger).toBe(false);
      expect(fn?.config).toStrictEqual(['search_path=pg_catalog, public', 'row_security=off']);
      expect(fn?.firedBy).toStrictEqual([]);
    });

    it('the fourth is the codes expiry, taking no argument', () => {
      // 20261002105957: no argument, so it deletes only rows past its fixed horizon; only the
      // upkeep identity executes it (second-factor-codes-retention).
      const expiry = definer('ops.expire_second_factor_codes()');
      expect(expiry?.trigger).toBe(false);
      expect(expiry?.argumentTypes).toStrictEqual([]);
      expect(expiry?.config).toStrictEqual(['search_path=pg_catalog']);
    });

    it('the fifth is the drill stamp, taking no argument', () => {
      // 0070 (C55): no argument, so it writes only now(); only the drill's
      // identity executes it (c55-last-tested-restore), refused above to every caller here.
      const stamp = definer('ops.record_tested_restore()');
      expect(stamp?.trigger).toBe(false);
      expect(stamp?.argumentTypes).toStrictEqual([]);
      expect(stamp?.config).toStrictEqual(['search_path=pg_catalog']);
    });
  });

  describe('the third security definer function', () => {
    it("is the ending's commit time, a trigger fired only by an insert of an ending", () => {
      // 20261004181806 (Sol OW-001-FIX2): it sets a new subject-wide ending's time at commit.
      const fn = functions.find(
        (one) => one.signature === 'ops.ended_subject_sessions_at_commit()',
      );
      expect(fn?.definer).toBe(true);
      expect(fn?.trigger).toBe(true);
      expect(fn?.config).toStrictEqual(['search_path=pg_catalog']);
      expect(fn?.firedBy).toStrictEqual([
        { table: 'ops.ended_subject_sessions', events: 'insert' },
      ]);
    });
  });

  // WF-1: the map read models' writers. Three fire on a map's parts, links and
  // records; the refresh they call takes the map's id. Each pins its search path.
  describe("the map read models' security definer functions", () => {
    const definer = (signature: string): CatalogueFunction | undefined =>
      functions.find((fn) => fn.definer && fn.signature === signature);

    it.each([
      ['map_summary_on_link()', true],
      ['map_summary_on_map_part()', true],
      ['map_summary_on_record()', true],
      ['map_summary_refresh(uuid)', false],
    ])('%s pins its search path (a trigger: %s)', (signature, trigger) => {
      const fn = definer(signature);
      expect(fn?.trigger).toBe(trigger);
      expect(fn?.config).toStrictEqual(['search_path=pg_catalog, public']);
    });
  });

  describe('the sixth security definer function', () => {
    it('is the pickup path, fired by nothing and under row security', () => {
      const fn = functions.find(
        (each) =>
          each.definer &&
          each.signature === 'take_lease(uuid,uuid,uuid,uuid,uuid,timestamp with time zone,text)',
      );
      expect(fn?.trigger).toBe(false);
      expect(fn?.config).toStrictEqual(['search_path=pg_catalog, pg_temp']);
      expect(fn?.firedBy).toStrictEqual([]);
    });
  });

  describe('the security definer function', () => {
    it('fires for the one role that may update or delete a report, and refuses it', async () => {
      // The permitted caller path. The application group was granted select
      // and insert only, so the owner is the only role whose update or delete
      // reaches the trigger at all, and the trigger refuses it.
      const table = 'public.handback_reports';
      const before = await fingerprint(world.db.admin, table);
      for (const text of [
        `update ${table} set business_id = business_id where business_id = $1 returning 1`,
        `delete from ${table} where business_id = $1 returning 1`,
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const outcome = await callers.call('owner', text, [world.alpha]);
        executed.push(`${table}\tdefiner via trigger\towner\t${describeOutcome(outcome)}`);
        expect(outcome.kind).toBe('raised');
        expect(outcome.kind === 'raised' ? outcome.message : '').toMatch(/append only/u);
      }
      expect(await fingerprint(world.db.admin, table)).toBe(before);
    });

    it('is never reached by an application caller, in its own tenant or another', async () => {
      const table = 'public.handback_reports';
      const before = await fingerprint(world.db.admin, table);
      for (const caller of [
        'login in the wrapper, own tenant',
        'login in the wrapper, other tenant',
        'login outside the wrapper',
      ] as const) {
        for (const text of [
          `update ${table} set business_id = business_id where business_id = $1 returning 1`,
          `delete from ${table} where business_id = $1 returning 1`,
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          const outcome = await callers.call(caller, text, [world.alpha]);
          executed.push(`${table}\tdefiner via trigger\t${caller}\t${describeOutcome(outcome)}`);
          // Refused by privilege before any row is read, so the trigger, and
          // with it the definer's elevated rights, is never entered.
          expect(describeOutcome(outcome)).toBe('denied');
        }
      }
      expect(await fingerprint(world.db.admin, table)).toBe(before);
    });
  });
});

// C80's live correction records, held on a world of their own after the cases
// above: P26's four findings, each its own block (`../site/live-correction-lows.ts`),
// then the re-bind review's round 2 on a second world (`../site/live-correction-lows-2.ts`),
// then Sol's first review on a third (`../site/live-correction-lows-sol.ts`).
describeLiveCorrectionLows();
describeLiveCorrectionLowsRoundTwo();
describeLiveCorrectionSolRoundOne();
