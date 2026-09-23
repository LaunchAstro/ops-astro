-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0023 a revoked delegation records why it was revoked.
--
-- Minimum contract 8.2 case 6 and ledger I08: when the delegating person's
-- underlying grant is revoked, the agent's next call on its still unexpired
-- credential answers `DELEGATION_NARROWED`. Authority loss also revokes the
-- delegation and classifies its holds in the same transaction (T5), so
-- `revoked_at` alone cannot tell that revocation from an explicit
-- `delegation.revoke` or from cancellation and supersession retiring the work.
-- The grants as they read later cannot tell either: they are mutable, and an
-- inference from them is not the fact the revoking transaction knew.
--
-- So the revocation writes its cause beside its timestamp, in the same update
-- (`authority/delegations.ts` `revokeDelegation`). Expiry and settlement are
-- their own columns and are never a revocation cause.
--
-- Additive. Every existing revoked row keeps a null cause: its reason was not
-- recorded, and nothing here or later invents one. A null cause answers as any
-- other revocation does. Once written, a cause is fixed.

alter table public.delegations
  add column revocation_cause text;

alter table public.delegations
  add constraint delegations_revocation_cause_known
    check (revocation_cause in ('authority_lost', 'delegation_revoked', 'work_retired'));

create function public.delegations_revocation_cause_is_fixed() returns trigger
  language plpgsql
  as $$
begin
  if old.revocation_cause is not null
     and new.revocation_cause is distinct from old.revocation_cause then
    raise exception 'delegations: a recorded revocation cause is fixed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.delegations_revocation_cause_is_fixed() from public;

create trigger delegations_revocation_cause_is_fixed
  before update on public.delegations
  for each row execute function public.delegations_revocation_cause_is_fixed();
