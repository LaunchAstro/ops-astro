-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Who may join a carriage topic (#1531): `carry:<business>:agent:<agent>`, that
-- agent alone; `carry:<business>:call:<call>`, while dispatched, the owner of
-- its conversation and the agent on its carriers row while a member there.
-- `ops_carry_may_join` resolves the JWT `sub` through this product's logins in
-- the topic's business only, as `standingOf` and `resolveAgentLogin` do; an
-- ended login, or any other shape (capitals included), is refused. Where
-- Realtime is installed, policies on `realtime.messages` ask it: receive on
-- either shape, send on a call topic only.

create function public.ops_carry_may_join(topic text)
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
  -- A session ended as `sessionEnded` reads it, from its first sign-in: the
  -- earliest `amr` time, a whole number however written (no later than
  -- `assuranceOf`'s); one it cannot read is before every ending.
  sid := case when pg_input_is_valid(claims::jsonb ->> 'session_id', 'uuid')
              then (claims::jsonb ->> 'session_id')::uuid end;
  select min(t)::bigint into signed
    from jsonb_array_elements(case jsonb_typeof(claims::jsonb -> 'amr')
                                when 'array' then claims::jsonb -> 'amr' else '[]' end) e,
         lateral (select case jsonb_typeof(e -> 'timestamp')
                           when 'number' then (e -> 'timestamp')::numeric end as t) n
   where t between 1 and 99999999999 and t = trunc(t);
  if sid is not null and (
       exists (select 1 from ops.ended_provider_sessions p where p.session_id = sid)
       or exists (select 1 from ops.ended_subject_sessions s
                   where s.subject_digest = encode(sha256(convert_to(sub, 'UTF8')), 'hex')
                     and s.kept_session is distinct from sid
                     and (signed is null or to_timestamp(signed) <= s.ended_before + interval '60 s'))
       or exists (select 1 from ops.subject_resets r
                   where r.subject_digest = encode(sha256(convert_to(sub, 'UTF8')), 'hex')
                     and (signed is null or to_timestamp(signed) <= r.open_until and r.settled_at is null
                          or to_timestamp(signed + 1) <= r.settled_at))) then
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
  );
end;
$$;

revoke all on function public.ops_carry_may_join(text) from public;

do $$
begin
  if to_regnamespace('realtime') is null then
    return;
  end if;
  execute 'grant execute on function public.ops_carry_may_join(text) to authenticated';
  execute $policy$
    create policy ops_carry_receive on realtime.messages
      for select to authenticated
      using (extension = 'broadcast' and public.ops_carry_may_join(realtime.topic()))
  $policy$;
  execute $policy$
    create policy ops_carry_send on realtime.messages
      for insert to authenticated
      with check (extension = 'broadcast'
                  and realtime.topic() like 'carry:%:call:%'
                  and public.ops_carry_may_join(realtime.topic()))
  $policy$;
end;
$$;
