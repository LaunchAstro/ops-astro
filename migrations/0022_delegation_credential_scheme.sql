-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0022 a delegation records how its credential was made.
--
-- A pickup whose response was lost must be able to get its credential back
-- without a second delegation (T3). A new delegation's credential is therefore
-- an HMAC of its fixed identity under a server key held outside the database
-- (`authority/credential-keys.ts`), and a replay derives it again. The row
-- needs two nonsecret facts to do that: which scheme made the credential and
-- which key id it was made under. The key bytes are never here, and the column
-- that holds the credential is still only its SHA-256.
--
-- Every existing row is `legacy-random`, which is the truth: its credential was
-- random bytes, and a digest cannot give them back. Nothing here or later
-- relabels a legacy row as derivable, and the trigger below refuses anybody
-- who tries. Additive: no existing value changes, and a legacy token presented
-- by its holder keeps working.
--
-- The derivation's inputs are the delegation's id, business and agent, and
-- the key id. The trigger freezes those, the scheme and the digest once
-- minted. Heartbeat, revocation and settlement still write their own columns.

alter table public.delegations
  add column credential_scheme text not null default 'legacy-random',
  add column credential_key_id text;

alter table public.delegations
  add constraint delegations_credential_scheme_known
    check (credential_scheme in ('legacy-random', 'hmac-sha256-v1')),
  add constraint delegations_credential_key_matches_scheme
    check (
      (credential_scheme = 'legacy-random' and credential_key_id is null)
      or (credential_scheme = 'hmac-sha256-v1'
          and credential_key_id ~ '^[A-Za-z0-9._@/-]{1,64}$')
    );

create function public.delegations_credential_is_fixed() returns trigger
  language plpgsql
  as $$
begin
  if new.id is distinct from old.id
     or new.business_id is distinct from old.business_id
     or new.agent_actor_id is distinct from old.agent_actor_id
     or new.credential_hash is distinct from old.credential_hash
     or new.credential_scheme is distinct from old.credential_scheme
     or new.credential_key_id is distinct from old.credential_key_id then
    raise exception 'delegations: the credential and the identity it was derived from are fixed at mint'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.delegations_credential_is_fixed() from public;

create trigger delegations_credential_is_fixed
  before update on public.delegations
  for each row execute function public.delegations_credential_is_fixed();
