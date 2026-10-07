-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A step's provider evidence is written once.
--
-- 0038 records on an attempt that its worker started its provider
-- (`provider_started_at`) and why it dropped (`drop_cause`), each written once,
-- and 0110 records a held model call's `drop_cause`. Nothing in storage held
-- them once written: the application role may update both tables (0014,
-- 0085), and 0014's trigger guards neither attempt column. The reconciliation
-- pass reads all three to tell "the step's own provider may have acted" from
-- "nothing happened" once a step's held calls are proved absent
-- (`withProviderCalls`, broker-effect.ts), so clearing or rewriting one would
-- turn a step that cannot be answered into one that is replaced. Each may now
-- move from null to a value once and never change or clear again. The writers
-- already write them so: the heartbeat keeps a provider start with `coalesce`,
-- a drop records its cause only where it is null, and the broker records a
-- call's cause as it leaves `reserved` or `dispatched`.
--
-- 0014's function is replaced whole with the two rules added; its trigger is
-- unchanged. The call rule is a new function and trigger. Both functions are
-- revoked from public; triggers call them without an execute grant.

create or replace function public.attempts_provenance_is_immutable() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attempts are immutable: attempt % cannot be deleted', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.id is distinct from old.id
     or new.business_id is distinct from old.business_id
     or new.reservation_id is distinct from old.reservation_id
     or new.envelope_id is distinct from old.envelope_id
     or new.version_id is distinct from old.version_id
     or new.run_id is distinct from old.run_id
     or new.step_id is distinct from old.step_id
     or new.synthetic is distinct from old.synthetic
     or new.price_book is distinct from old.price_book
     or new.estimated_minor is distinct from old.estimated_minor
     or new.created_at is distinct from old.created_at then
    raise exception 'attempts are immutable: attempt % has provenance that cannot be edited', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.actual_minor is not null and new.actual_minor is distinct from old.actual_minor then
    raise exception 'attempt % is already settled at %', old.id, old.actual_minor
      using errcode = 'restrict_violation';
  end if;
  if old.outcome is not null and new.outcome is distinct from old.outcome then
    raise exception 'attempt % already recorded outcome %', old.id, old.outcome
      using errcode = 'restrict_violation';
  end if;
  -- A marker is evidence that something happened outside this head's reachable
  -- operations. It can be raised and it can never be lowered, because lowering
  -- it is how a real liability would be erased.
  if old.dispatch_marker and not new.dispatch_marker then
    raise exception 'attempt % carries a dispatch marker, which cannot be cleared', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.observed and not new.observed then
    raise exception 'attempt % carries an observation, which cannot be cleared', old.id
      using errcode = 'restrict_violation';
  end if;
  -- The same holds for the evidence that the step reached its provider.
  if old.provider_started_at is not null
     and new.provider_started_at is distinct from old.provider_started_at then
    raise exception 'attempt % recorded its provider start, which cannot be changed', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.drop_cause is not null and new.drop_cause is distinct from old.drop_cause then
    raise exception 'attempt % recorded drop cause %, which cannot be changed', old.id, old.drop_cause
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.attempts_provenance_is_immutable() from public;

create function public.model_calls_drop_cause_is_written_once() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'model call % recorded drop cause %, which cannot be changed', old.id, old.drop_cause
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function public.model_calls_drop_cause_is_written_once() from public;

create trigger model_calls_drop_cause_is_written_once
  before update on public.model_calls
  for each row
  when (old.drop_cause is not null and new.drop_cause is distinct from old.drop_cause)
  execute function public.model_calls_drop_cause_is_written_once();
