-- SPDX-License-Identifier: AGPL-3.0-only
--
-- No sign-in is mapped to an agent while its cleanup runs.
--
-- `scripts/security/scan-login.mjs remove` holds the login subject lock
-- (20261004102920) from its live-elsewhere check through the provider delete,
-- and only `person_logins` took it. One provider user can be an agent's login
-- in another business (20261006213100), so an agent mapping committed in that
-- window was left live against a deleted account. `actor_logins` now passes
-- through the same trigger function: a write that leaves a mapping live takes
-- the lock shared, or is refused (lock_not_available) while the cleanup holds
-- it. The function reads only `business_id`, `login_id` and `active`, which
-- both tables carry; it is 20261004102920's, unchanged, so nothing new is
-- granted.

create trigger actor_logins_subject_not_in_cleanup
  before insert or update on public.actor_logins
  for each row execute function public.person_login_subject_not_in_cleanup();
