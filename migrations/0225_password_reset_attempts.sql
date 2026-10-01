-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0225 password reset mail, by login (C40). A reset is a login's, not one
-- business's: the login provider holds one password per sign-in login, so a
-- reset asked through any business the login reaches is one reset, and its
-- rate limits (per address and per account, SP-14) count the login's mail.
--
-- One row when the provider's Send Email hook asks for a reset mail
-- (`asked`, its evidence the hook message's id, `hook:<id>`, held unique so a
-- replayed message sends nothing), and one when the mail provider answers
-- (`accepted` with its message id, or `failed` with the fault's kind): the
-- login's subject and the address, each as a SHA-256 digest, the attempt's
-- random id, the state, the evidence and when. The row names no business,
-- person, token or link. The application group may insert the first five
-- columns and read all six; it changes and removes nothing, and the time is
-- the database's own.

create table ops.password_reset_attempts (
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  address_digest text not null check (address_digest ~ '^[0-9a-f]{64}$'),
  attempt uuid not null,
  state text not null check (state in ('asked', 'accepted', 'failed')),
  evidence text not null check (length(evidence) <= 200),
  recorded_at timestamptz not null default now()
);
create unique index password_reset_attempts_asked
  on ops.password_reset_attempts (evidence) where state = 'asked';
create index password_reset_attempts_subject
  on ops.password_reset_attempts (subject_digest, recorded_at);
create index password_reset_attempts_address
  on ops.password_reset_attempts (address_digest, recorded_at);
revoke all on ops.password_reset_attempts from public;
grant select (subject_digest, address_digest, attempt, state, evidence, recorded_at),
  insert (subject_digest, address_digest, attempt, state, evidence)
  on ops.password_reset_attempts to ops_astro_app;
