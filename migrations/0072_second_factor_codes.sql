-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0072 wrong second-factor codes counted by login (C59). The provider holds
-- one set of factors per sign-in login, so a code sent through any business
-- the login reaches is a guess at the same factor, and the wrong-code lockout
-- (five in fifteen minutes) counts the login's codes, not one business's.
--
-- One row when a code is sent to the provider, and one when it is answered
-- other than wrong: the login's subject as a SHA-256 digest, the attempt's
-- random id (the act's audit event in its business carries it as its
-- operation), `sent` or `answered`, and when. A code sent and not answered
-- counts, so codes sent at once count each other; the factor routes take a
-- transaction-scoped lock on the subject before counting. The row names no
-- business, person or reason. The application group may insert the first
-- three columns and read the four; it changes and removes nothing, and the
-- time is the database's own.

create table ops.second_factor_codes (
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  attempt uuid not null,
  state text not null check (state in ('sent', 'answered')),
  recorded_at timestamptz not null default now()
);
create index second_factor_codes_subject on ops.second_factor_codes (subject_digest, recorded_at);
revoke all on ops.second_factor_codes from public;
grant select (subject_digest, attempt, state, recorded_at), insert (subject_digest, attempt, state)
  on ops.second_factor_codes to ops_astro_app;

-- The agent door's read-only live check looks a bearer up by business and
-- hash (security review round 5); this index serves it, rather than a filter
-- over the business's rows. Not unique: no constraint makes hashes unique.
create index agent_credentials_door
  on public.agent_credentials (business_id, credential_hash);
