-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0066 an access ending whose provider steps were skipped (C58, ORCH46
-- ruling A). The sign-in provider's user is one person's across every
-- business, while a login row is one business's. While the ending login's
-- subject is still live in another business, banning the provider user would
-- end that business's access too, so the steps are stamped done without a
-- call and the reason is kept here: `shared`. The API's own ending stands
-- either way. Null is a step the provider was asked for, or one still owed.

alter table public.access_endings
  add column provider_steps_skipped text,
  add constraint access_endings_skipped_known check (
    provider_steps_skipped is null or provider_steps_skipped = 'shared'
  );
