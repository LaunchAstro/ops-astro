-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Password reset on the provider's one-time recovery session (stub: the rows only).

create table ops.password_reset_requests (
  id            uuid        primary key,
  address       text        not null,
  caller_digest text        not null,
  requested_at  timestamptz not null default clock_timestamp(),
  state         text        not null default 'owed',
  settled_at    timestamptz
);

create table ops.recovery_links (
  id             uuid        primary key,
  subject_digest text        not null,
  minted_at      timestamptz not null default clock_timestamp(),
  consumed_at    timestamptz
);

create table ops.recovery_resets (
  session_digest text        primary key,
  reset_id       uuid        not null references ops.subject_resets (id),
  opened_at      timestamptz not null default clock_timestamp(),
  settled_at     timestamptz
);
