-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261003173600 the backup and lookup identities hold no other role.
-- 0045 and 0046 make each identity, or repair the attributes of one made
-- earlier by hand, and grant it only what it reads. Neither took away a role
-- the identity was already a member of, and each reads past row security: a
-- backup identity left in the application group kept the group's writes, and a
-- lookup identity left in it read every business's people. Neither is meant to
-- be a member of anything (a login is a member of them, never the other way),
-- so every membership either holds is revoked here, whoever granted it, and the
-- run stops if one is left.
--
-- Both roles are the cluster's, shared by every database on it. Two databases
-- migrating at once can both find the same membership; the second's revoke
-- then waits for the first and fails with "tuple concurrently deleted"
-- (internal_error). That is caught, and the role judged again once the first
-- has committed, so a race costs neither run.

do $$
declare
  held record;
begin
  for held in
    select m.roleid::regrole::text as granted, m.member::regrole::text as member,
           m.grantor::regrole::text as grantor
      from pg_auth_members m
     where m.member in ('ops_astro_backup'::regrole, 'ops_astro_lookup'::regrole)
  loop
    begin
      execute format('revoke %s from %s granted by %s', held.granted, held.member, held.grantor);
    exception when internal_error then
      null;
    end;
  end loop;
  if exists (select from pg_auth_members
              where member in ('ops_astro_backup'::regrole, 'ops_astro_lookup'::regrole)) then
    raise exception 'ops_astro_backup or ops_astro_lookup still holds another role'
      using errcode = 'insufficient_privilege';
  end if;
end $$;
