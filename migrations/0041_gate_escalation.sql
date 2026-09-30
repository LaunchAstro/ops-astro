-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0041 escalation on the gate (T3a).
--
-- At the revision bound a person may escalate a gate instead of approving or
-- rejecting it. The escalation role is the gate's own authority one scope
-- wider: a holder of `decide` at business scope (orchestrator decision on
-- ops-astro#153). Escalating is not the gate's decision, so it writes no
-- `gate_decisions` row and the one-decision-per-gate index stands: it records
-- who escalated and to whom on the gate itself, the gate stays `pending`, and
-- `decide` then admits only a business-scope decider. A later escalation to
-- another holder replaces the recipient; each one is in the audit trail.
-- No trigger here (RN-12): `decide` writes these columns under the gate lock.

alter table public.gates
  add column escalated_to_person_id uuid,
  add column escalated_by_person_id uuid,
  add column escalated_by_actor_id  uuid,
  add column escalated_at           timestamptz;

alter table public.gates
  add constraint gates_escalated_to_fkey foreign key (business_id, escalated_to_person_id)
    references public.people (business_id, id),
  add constraint gates_escalated_by_fkey foreign key (business_id, escalated_by_person_id)
    references public.people (business_id, id),
  add constraint gates_escalated_by_actor_fkey foreign key (business_id, escalated_by_actor_id)
    references public.actors (business_id, id),
  -- All four or none: an escalation without a recipient, an actor or a time is
  -- a row a reader would have to guess about.
  add constraint gates_escalation_whole check (
    (escalated_to_person_id is null) = (escalated_by_person_id is null)
    and (escalated_to_person_id is null) = (escalated_by_actor_id is null)
    and (escalated_to_person_id is null) = (escalated_at is null)
  );
