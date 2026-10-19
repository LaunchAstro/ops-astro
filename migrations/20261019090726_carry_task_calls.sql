-- SPDX-License-Identifier: AGPL-3.0-only
--
-- A task's call carried to the model agent on the owner's machine (#1703,
-- #1620 P5). Its carriers row is written as a conversation call's is, ids and
-- times only, once the call is dispatched; nothing else about the row changes.
-- Its call topic is joined by two logins: the agent holding the call's lease,
-- which offers and sends from the hosted side with its own token, and the
-- agent on the carriers row, the model agent, which answers. Neither needs a
-- conversation. A conversation call's rules are unchanged.

create or replace function public.model_call_carriers_guard() returns trigger
  language plpgsql
  as $$
begin
  if tg_op = 'INSERT' and (new.offered_at is not null or new.runner is not null or not exists (
       select 1 from public.model_calls c
        where c.business_id = new.business_id and c.id = new.call_id
          and (c.conversation_id is not null or c.lease_id is not null)
          and c.state = 'dispatched'
          for share))
     or tg_op = 'UPDATE' and (
       old.runner is null and new.runner is not null and not exists (
         select 1 from public.model_calls c
          where c.business_id = new.business_id and c.id = new.call_id and c.state = 'dispatched'
            for share)
       or (new.business_id, new.call_id, new.agent_actor_id)
         is distinct from (old.business_id, old.call_id, old.agent_actor_id)
       or old.offered_at is not null and new.offered_at is distinct from old.offered_at
       or old.runner is not null and (new.runner, new.request_at, new.send_by, new.answer_by)
         is distinct from (old.runner, old.request_at, old.send_by, old.answer_by)) then
    raise exception 'model_call_carriers: written unset for a dispatched call, set once'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- The join, as 20261013010300 wrote it, with a task call's two logins added.
create or replace function public.ops_carry_may_join(topic text)
  returns boolean
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, public
  set row_security = off
  as $$
declare
  parts text[];
  claims text;
  sub text;
  business uuid;
  named uuid;
  login uuid;
  sid uuid;
  signed bigint;
  strong boolean;
begin
  parts := regexp_match(
    topic,
    '^carry:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
    ':(agent|call):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  if parts is null then
    return false;
  end if;
  claims := nullif(current_setting('request.jwt.claims', true), '');
  if claims is null or not pg_input_is_valid(claims, 'jsonb') then
    return false;
  end if;
  sub := claims::jsonb ->> 'sub';
  if sub is null or sub = '' then
    return false;
  end if;
  business := parts[1]::uuid;
  named := parts[3]::uuid;
  select l.id into login
    from public.logins l
   where l.business_id = business and l.provider = 'supabase' and l.subject = sub
     and not exists (select 1 from public.access_endings e
                      where e.business_id = l.business_id and e.login_id = l.id);
  if login is null then
    return false;
  end if;
  -- The session, by the rules login resolution asks (`ops.session_refusal`),
  -- the 12 hours included: the token read as `assuranceOf` and `sessionIdOf`
  -- read it, the first sign-in its earliest first-factor `amr` time. Each
  -- entry as JSON.parse and `String(method)` read it: a time rounded to a
  -- double, a method through any one-item lists.
  sid := case when claims::jsonb ->> 'session_id'
                   ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (claims::jsonb ->> 'session_id')::uuid end;
  select min(t) filter (where m in ('password', 'otp', 'magiclink', 'email/signup',
                                    'recovery', 'invite', 'oauth', 'sso/saml'))::bigint,
         claims::jsonb ->> 'aal' = 'aal2' and bool_or(e ->> 'method' = 'totp')
    into signed, strong
    from jsonb_array_elements(case jsonb_typeof(claims::jsonb -> 'amr')
                                when 'array' then claims::jsonb -> 'amr' else '[]' end) e,
         lateral (select case when jsonb_typeof(e -> 'timestamp') = 'number'
                               and (e -> 'timestamp')::numeric > 0.5
                               and (e -> 'timestamp')::numeric < 9007199254740993
                          then (e -> 'timestamp')::numeric::float8 end as t,
                         substring((e -> 'method')::text from '^\[*"([^"\\]*)"\]*$') as m) n
   where t between 1 and 9007199254740991 and t = trunc(t);
  if ops.session_refusal(sub, sid, signed, coalesce(strong, false), true, true) is not null then
    return false;
  end if;

  if parts[2] = 'agent' then
    return exists (
      select 1 from public.actor_logins al
        join public.actors a on a.business_id = al.business_id and a.id = al.actor_id
       where al.business_id = business and al.login_id = login and al.active
         and a.id = named and a.kind = 'agent' and a.active);
  end if;

  return exists (
    -- The owner of the call's conversation, signed in as themselves.
    select 1
      from public.model_calls c
      join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      join public.conversations v on v.business_id = c.business_id and v.id = c.conversation_id
      join public.person_logins pl
        on pl.business_id = c.business_id and pl.login_id = login and pl.active
      join public.memberships m
        on m.business_id = pl.business_id and m.person_id = pl.person_id and m.active
      join public.actors a
        on a.business_id = pl.business_id and a.person_id = pl.person_id
       and a.kind = 'person' and a.active
     where c.business_id = business and c.id = named and c.state = 'dispatched'
       and v.owner_actor_id = a.id and v.body_purged_at is null
  ) or exists (
    -- The agent the call was given to, while it is a member of the conversation.
    select 1
      from public.model_calls c
      join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      join public.actor_logins al
        on al.business_id = c.business_id and al.login_id = login and al.active
      join public.actors a
        on a.business_id = al.business_id and a.id = al.actor_id
       and a.kind = 'agent' and a.active
      join public.conversation_agent_members cm
        on cm.business_id = c.business_id and cm.conversation_id = c.conversation_id
       and cm.agent_actor_id = a.id and cm.left_at is null
     where c.business_id = business and c.id = named and c.state = 'dispatched'
       and k.agent_actor_id = a.id
  ) or exists (
    -- A task's call: the agent holding its live lease, signed in as itself.
    select 1
      from public.model_calls c
      join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      join public.leases l on l.business_id = c.business_id and l.id = c.lease_id
      join public.actor_logins al
        on al.business_id = c.business_id and al.login_id = login and al.active
      join public.actors a
        on a.business_id = al.business_id and a.id = al.actor_id
       and a.kind = 'agent' and a.active
     where c.business_id = business and c.id = named and c.state = 'dispatched'
       and c.conversation_id is null and l.state = 'live' and l.holder_actor_id = a.id
  ) or exists (
    -- A task's call: the agent on its carriers row.
    select 1
      from public.model_calls c
      join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      join public.actor_logins al
        on al.business_id = c.business_id and al.login_id = login and al.active
      join public.actors a
        on a.business_id = al.business_id and a.id = al.actor_id
       and a.kind = 'agent' and a.active
     where c.business_id = business and c.id = named and c.state = 'dispatched'
       and c.conversation_id is null and k.agent_actor_id = a.id
  );
end;
$$;

revoke all on function public.ops_carry_may_join(text) from public;
