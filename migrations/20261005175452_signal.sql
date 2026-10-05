-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is"): ported from
-- b0/SL13's 0034 after migrations moved to timestamps.
--
-- 20261005161600 signal: what is watching (tripwires) and what the night round
-- did, in order (MP-14-8, Connections & signal sections 007 and 008).
--
-- Grants (section 006) need no table: a grant is a delegation (0008), and its
-- redemptions are the calls its agent made under it (the audit chain, 0007).
--
-- The application role only reads these. Tripwires are written by the checks
-- that watch, and the night round's steps by the round itself (the agent
-- loops, not built); until then the tests seed them as the database owner, as
-- they do connections (20261005153051).
--
-- Every column of these two tables drawn as words is `signal_text`: a closed
-- grammar, an explicit allow-list refused whole unless every character is on
-- it (a grant's client label is `clients.name`, outside it).
-- Printable ASCII; Latin-1 and Latin Extended letters and signs (U+00A1 to
-- U+024F, less the soft hyphen U+00AD); dashes, quotes, bullets and the
-- other visible general punctuation (U+2010 to U+2027, U+2030 to U+205E);
-- currency signs; arrows. A space only between two of those. Everything else
-- is refused: control, format, bidi, tag and invisible characters, variation
-- selectors, combining marks, separators other than the space, and any script
-- the list does not name. A task cite is a task key (`T-<n>`, `nextTaskKey`),
-- a filed item an attention item's display id. A row naming a client names a
-- client of its own business, by foreign key.
create domain public.signal_text as text
  constraint signal_text_shape check (
    value ~ '^[!-~\u00A1-\u00AC\u00AE-\u024F\u2010-\u2027\u2030-\u205E\u20A0-\u20C0\u2190-\u21FF]([ !-~\u00A1-\u00AC\u00AE-\u024F\u2010-\u2027\u2030-\u205E\u20A0-\u20C0\u2190-\u21FF]*[!-~\u00A1-\u00AC\u00AE-\u024F\u2010-\u2027\u2030-\u205E\u20A0-\u20C0\u2190-\u21FF])?$');

-- A tripwire is a stated check. `cannot_be_armed` is not "off": the data the
-- check needs does not exist, and `blocked_reason` names which. Such a check
-- has no firing history to have, so it carries none.
create table public.tripwires (
  business_id    uuid        not null,
  id             uuid        not null,
  what           public.signal_text not null,
  rule           public.signal_text not null,
  watching       public.signal_text not null,
  state          text        not null,
  blocked_reason public.signal_text,
  fired_count    integer     not null default 0,
  last_fired_at  timestamptz,
  -- The attention item the last firing filed (its display id), or why it
  -- filed nothing. Neither when it has never fired.
  filed_item     text,
  filed_nothing  public.signal_text,
  note           public.signal_text,
  -- The client the check watches; null watches the whole fleet.
  client_id      uuid,
  created_at     timestamptz not null default now(),
  constraint tripwires_pkey primary key (id),
  constraint tripwires_tenant_id_key unique (business_id, id),
  constraint tripwires_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint tripwires_client_fkey foreign key (business_id, client_id)
    references public.clients (business_id, id),
  constraint tripwires_text_length check (
    char_length(what) <= 200 and char_length(rule) <= 500 and char_length(watching) <= 500
    and char_length(blocked_reason) <= 500 and char_length(filed_nothing) <= 500
    and char_length(note) <= 500),
  constraint tripwires_filed_item_shape check (filed_item ~ '^[A-Z]{1,4}-[1-9][0-9]{0,17}$'),
  constraint tripwires_state_known check (state in ('armed', 'cannot_be_armed')),
  constraint tripwires_blocked_names_why check ((state = 'cannot_be_armed') = (blocked_reason is not null)),
  constraint tripwires_unarmed_never_fired check (
    state = 'armed' or (fired_count = 0 and last_fired_at is null and filed_item is null
                        and filed_nothing is null)),
  constraint tripwires_fired_count_counts check (fired_count >= 0),
  constraint tripwires_fired_is_dated check ((fired_count = 0) = (last_fired_at is null)),
  constraint tripwires_filed_one_way check (filed_item is null or filed_nothing is null),
  constraint tripwires_filed_after_firing check (
    fired_count > 0 or (filed_item is null and filed_nothing is null))
);

-- One step of a night round. `round_on` names the round (the morning it hands
-- over); `cite_kind` and `cite_ref` say where the fact the step reports lives:
-- a section of this page, or a task by its key.
create table public.night_round_steps (
  business_id uuid        not null,
  id          uuid        not null,
  round_on    date        not null,
  at          timestamptz not null,
  tone        text        not null,
  what        public.signal_text not null,
  who         public.signal_text not null,
  say         public.signal_text not null,
  cite_kind   text,
  cite_ref    text,
  cite_label  public.signal_text,
  client_id   uuid,
  constraint night_round_steps_pkey primary key (id),
  constraint night_round_steps_tenant_id_key unique (business_id, id),
  constraint night_round_steps_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint night_round_steps_client_fkey foreign key (business_id, client_id)
    references public.clients (business_id, id),
  constraint night_round_steps_tone_known check (tone in ('plain', 'watch', 'bad')),
  constraint night_round_steps_text_length check (
    char_length(what) <= 200 and char_length(who) <= 100 and char_length(say) <= 500
    and char_length(cite_label) <= 100),
  constraint night_round_steps_cite_kind_known check (
    cite_kind in ('grants', 'tripwires', 'exceptions', 'task')),
  constraint night_round_steps_cite_ref_shape check (cite_ref ~ '^T-[1-9][0-9]{0,17}$'),
  constraint night_round_steps_cite_whole check (
    (cite_kind is null) = (cite_label is null)
    and coalesce(cite_kind = 'task', false) = (cite_ref is not null))
);

create index night_round_steps_round_idx on public.night_round_steps (business_id, round_on, at);

alter table public.tripwires enable row level security;
alter table public.tripwires force row level security;
alter table public.night_round_steps enable row level security;
alter table public.night_round_steps force row level security;

create policy tenancy_tripwires on public.tripwires
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_tripwires on public.tripwires
  as permissive for all using (true) with check (true);

create policy tenancy_night_round_steps on public.night_round_steps
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));
create policy authority_night_round_steps on public.night_round_steps
  as permissive for all using (true) with check (true);

grant select on public.tripwires to ops_astro_app;
grant select on public.night_round_steps to ops_astro_app;
