-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0064 a verified second factor holds in every business (C59). The provider
-- holds one set of factors per sign-in login, so a factor verified through
-- one business is the login's factor in every business it reaches.
--
-- One row per factor verified or removed, written beside its `second_factors`
-- row: the login's subject and the provider's factor id, each as a SHA-256
-- digest, and which of the two happened. Login resolution refuses a sign-in
-- short of `aal2` (`AUTH_SECOND_FACTOR_REQUIRED`) while the subject has a
-- factor verified and not removed. A removed factor is never verified again
-- (a new enrolment is a new factor), so the rows need no order. The row names
-- no business, person or reason. The application group may insert the three
-- columns and read them; it changes and removes nothing. Nothing is carried
-- over: no installation holds a 0049 factor without this migration.

create table ops.second_factor_subjects (
  subject_digest text not null check (subject_digest ~ '^[0-9a-f]{64}$'),
  factor_digest text not null check (factor_digest ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('verified', 'removed'))
);
create index second_factor_subjects_subject on ops.second_factor_subjects (subject_digest);
revoke all on ops.second_factor_subjects from public;
grant select (subject_digest, factor_digest, state), insert (subject_digest, factor_digest, state)
  on ops.second_factor_subjects to ops_astro_app;
