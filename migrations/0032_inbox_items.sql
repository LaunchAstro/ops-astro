-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0032 the inbox's three records (INB-1a, U99).
--
-- Delivery is addressing, and addressing is not authority
-- (docs/decisions/delivery-and-presence.md, "Notification delivery"). Three
-- records are never one: the fact stays where it is already durable, the inbox
-- item is one recipient's (subject, reason) obligation holding a pointer, and
-- each delivery attempt carries its own evidence.
--
-- Four axes, four owners. Work state is the item's `work_state`. Attention is
-- the recipient's own row in `inbox_attention`, keyed by the item. Delivery is
-- per attempt in `inbox_delivery_attempts`. Access has no column: it is derived
-- at every read from the recipient's live grants and the task
-- (`packages/core-records/src/inbox/items.ts`), so a lost grant withholds an
-- item at the next read without touching it, and withheld is not gone.
--
-- Nothing here reaches the gate, gate-decision or proposal tables. A decision
-- item points at its gate by `fact_id` and holds no foreign key to it, so no
-- constraint lands on the gate engine's tables (INB-1, RN-12).

create table public.inbox_items (
  business_id            uuid        not null,
  id                     uuid        not null,
  recipient_person_id    uuid        not null,
  -- The task the item is about. The inbox lives inside Tasks, so every
  -- subject is a record; a wayfinder item's subject is its round or ticket.
  subject_record_id      uuid        not null,
  reason                 text        not null,
  -- The pointer to the fact: which durable row raised this, never its content.
  fact_kind              text        not null,
  fact_id                uuid        not null,
  -- Counted or not. Only a finished run needs no response (CS-16.8).
  owed                   boolean     not null default true,
  work_state             text        not null default 'open',
  raised_at              timestamptz not null default now(),
  closed_at              timestamptz,
  closed_by_person_id    uuid,
  closed_by_operation_id uuid,
  constraint inbox_items_pkey primary key (id),
  constraint inbox_items_tenant_id_key unique (business_id, id),
  -- What an attention row's foreign key names, so it cannot name anyone else.
  constraint inbox_items_recipient_key unique (business_id, id, recipient_person_id),
  constraint inbox_items_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint inbox_items_recipient_fkey foreign key (business_id, recipient_person_id)
    references public.people (business_id, id),
  -- A purged task takes its items with it; a trashed one leaves them, gone.
  constraint inbox_items_subject_fkey foreign key (business_id, subject_record_id)
    references public.records (business_id, id) on delete cascade,
  constraint inbox_items_closed_by_fkey foreign key (business_id, closed_by_person_id)
    references public.people (business_id, id),
  constraint inbox_items_reason_known check (reason in (
    'decision', 'waiting_run', 'run_finished', 'assignment', 'mention', 'incident',
    'client_comment')),
  constraint inbox_items_fact_kind_known
    check (fact_kind in ('gate', 'planned_run', 'record', 'operation')),
  constraint inbox_items_owed_by_reason check (owed = (reason <> 'run_finished')),
  constraint inbox_items_work_state_known
    check (work_state in ('open', 'cleared', 'withdrawn')),
  constraint inbox_items_closed_is_whole
    check ((work_state = 'open') = (closed_at is null)),
  -- A cleared item names who decided (INB-1, checklist); an open one names nobody.
  constraint inbox_items_cleared_names_decider check (
    (work_state = 'cleared') = (closed_by_person_id is not null))
);

-- One open obligation per recipient, subject, reason and fact: raising twice
-- in a replayed transition finds the item already there.
create unique index inbox_items_one_open_idx
  on public.inbox_items (business_id, recipient_person_id, subject_record_id, reason, fact_kind, fact_id)
  where work_state = 'open';

create index inbox_items_business_idx on public.inbox_items (business_id);

create index inbox_items_recipient_open_idx
  on public.inbox_items (business_id, recipient_person_id) where work_state = 'open';

create index inbox_items_subject_idx on public.inbox_items (business_id, subject_record_id);

-- The recipient's own attention row: `seen` is a preference keyed by the item,
-- never a field on the shared item. The foreign key carries the recipient, so
-- a row for anybody else fails in the schema.
create table public.inbox_attention (
  business_id uuid        not null,
  item_id     uuid        not null,
  person_id   uuid        not null,
  seen_at     timestamptz not null default now(),
  constraint inbox_attention_pkey primary key (business_id, item_id),
  constraint inbox_attention_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint inbox_attention_recipient_fkey foreign key (business_id, item_id, person_id)
    references public.inbox_items (business_id, id, recipient_person_id) on delete cascade
);

-- One row per observation of one attempt on one channel. Asked, accepted and
-- delivered are three states, and seen is attention's, never an attempt's:
-- nothing here can read "delivered" when only "sent" is known.
create table public.inbox_delivery_attempts (
  business_id uuid        not null,
  id          uuid        not null,
  item_id     uuid        not null,
  channel     text        not null,
  state       text        not null,
  evidence    text,
  observed_at timestamptz not null default now(),
  -- Causal order. `now()` is the transaction's start, so two observations in
  -- one transaction share it; the sequence orders them as they were written.
  observed_seq bigint     generated by default as identity,
  constraint inbox_delivery_attempts_pkey primary key (id),
  constraint inbox_delivery_attempts_tenant_id_key unique (business_id, id),
  constraint inbox_delivery_attempts_business_fkey foreign key (business_id, business_id)
    references public.businesses (business_id, id),
  constraint inbox_delivery_attempts_item_fkey foreign key (business_id, item_id)
    references public.inbox_items (business_id, id) on delete cascade,
  constraint inbox_delivery_attempts_channel_known check (channel in ('in_app', 'email')),
  constraint inbox_delivery_attempts_state_known
    check (state in ('asked', 'accepted', 'delivered', 'failed'))
);

create index inbox_delivery_attempts_item_idx
  on public.inbox_delivery_attempts (business_id, item_id);

alter table public.inbox_items enable row level security;
alter table public.inbox_items force row level security;
alter table public.inbox_attention enable row level security;
alter table public.inbox_attention force row level security;
alter table public.inbox_delivery_attempts enable row level security;
alter table public.inbox_delivery_attempts force row level security;

create policy tenancy_inbox_items on public.inbox_items
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_inbox_items on public.inbox_items
  as permissive for all using (true) with check (true);

create policy tenancy_inbox_attention on public.inbox_attention
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_inbox_attention on public.inbox_attention
  as permissive for all using (true) with check (true);

create policy tenancy_inbox_delivery_attempts on public.inbox_delivery_attempts
  as restrictive for all
  using (business_id = (select public.app_business_id()))
  with check (business_id = (select public.app_business_id()));

create policy authority_inbox_delivery_attempts on public.inbox_delivery_attempts
  as permissive for all using (true) with check (true);

-- The item's work state moves (cleared, withdrawn), so it takes update. An
-- attempt and a seen stamp are observations: insert only, never rewritten or
-- deleted by the application.
grant select, insert, update on public.inbox_items to ops_astro_app;
grant select, insert on public.inbox_attention to ops_astro_app;
grant select, insert on public.inbox_delivery_attempts to ops_astro_app;
