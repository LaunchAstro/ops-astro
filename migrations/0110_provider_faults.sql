-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0110 real provider faults on a model call (AW-10).
--
-- A call held as unknown liability now says which drop it was, whose fault,
-- and where the work got to, from evidence only:
--   drop_cause      provider_unavailable (the provider answered that it is
--                   down or limiting), connection_lost (the connection was
--                   cut with no answer) or worker_lost (our side was lost);
--                   null for a failure that is no drop (a bounded hostile
--                   answer, a timeout, a price above the hold)
--   fault           whose it was: provider, network, ours, or undetermined
--                   when the evidence cannot say (a timeout)
--   provider_code   the provider's refusal code (`http_503`), or null when
--                   none arrived
--   unknown_since   when the call was first held unknown
--   reconcile_mode  provider_lookup when the pass may ask the provider and
--                   the operation declared the answers that prove nothing
--                   happened; person when only a person can say
--   reconcile_note  what the pass last established, in plain words
--   outcome         what a person recorded for the call's step: nothing
--                   happened, it happened, it happened differently, or the
--                   liability was written off; with the person who did
--
-- A call proved absent by the provider's declared answer, or resolved by a
-- person's outcome, leaves `liability_unknown` and keeps its drop as history,
-- so the drop no longer requires the held state, only that it was once held.
-- No table, function or grant is added; row security is unchanged.

alter table public.model_calls
  add column drop_cause text,
  add column provider_code text,
  add column unknown_since timestamptz,
  add column reconcile_mode text,
  add column reconcile_note text,
  add column outcome text,
  add column outcome_person_id uuid;

update public.model_calls
   set unknown_since = coalesce(started_at, accepted_at)
 where state = 'liability_unknown' or drop_state is not null;

alter table public.model_calls drop constraint model_calls_fault_known;
alter table public.model_calls add constraint model_calls_fault_known
  check (fault is null or fault in ('ours', 'provider', 'network', 'undetermined'));

alter table public.model_calls drop constraint model_calls_drop_is_held;
alter table public.model_calls add constraint model_calls_drop_was_held
  check ((drop_state is null and drop_cause is null) or unknown_since is not null);

alter table public.model_calls add constraint model_calls_held_is_dated
  check (state <> 'liability_unknown' or unknown_since is not null);

alter table public.model_calls add constraint model_calls_drop_cause_known
  check (drop_cause is null
         or drop_cause in ('provider_unavailable', 'connection_lost', 'worker_lost'));

alter table public.model_calls add constraint model_calls_provider_code_shape
  check (provider_code is null or provider_code ~ '^[a-z][a-z0-9_]{0,63}$');

alter table public.model_calls add constraint model_calls_reconcile_mode_known
  check (reconcile_mode is null or reconcile_mode in ('provider_lookup', 'person'));

alter table public.model_calls add constraint model_calls_reconcile_note_bounded
  check (reconcile_note is null or length(reconcile_note) <= 300);

alter table public.model_calls add constraint model_calls_outcome_known
  check (outcome is null
         or outcome in ('nothing_happened', 'happened', 'happened_differently', 'written_off'));

alter table public.model_calls add constraint model_calls_outcome_has_person
  check ((outcome is null) = (outcome_person_id is null));

alter table public.model_calls add constraint model_calls_outcome_was_held
  check (outcome is null or unknown_since is not null);
