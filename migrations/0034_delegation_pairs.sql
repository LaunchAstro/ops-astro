-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0034 delegation pairs. A delegation stores exactly the (collection, action)
-- pairs checked when it was minted, and nothing else (ORCH25-SL12B-PAIRS).
--
-- 0008 stored `collections` and `actions` as two lists and read their product.
-- That held while every delegation was one collection by its actions, and it
-- stops holding the moment one is not: pickup mints the task's read, comment
-- and write plus `run:write` where the delegating person holds it
-- (ORCH25-SL12B-RUN). Stored as a product, that row would read as covering
-- `run:read` and `run:comment`, which nobody checked, and the call-time grant
-- check would let them through once the person gained them: an authority
-- widened after mint. Each pair is one `collection:action` text, so the row
-- says what was checked and the call-time lookup is one membership test
-- (`authority/delegations.ts` `checkDelegatedAuthority`).
--
-- Existing rows move to their exact pairs, which is the product they already
-- stood for, in the order it was read (each collection in turn, its actions
-- in their order), so what each allows does not change. The two lists then go.

alter table public.delegations add column pairs text[];

update public.delegations d
   set pairs = (
     select array_agg(c || ':' || a order by ci, ai)
       from unnest(d.collections) with ordinality as cs (c, ci)
            cross join unnest(d.actions) with ordinality as acts (a, ai)
   );

alter table public.delegations
  alter column pairs set not null,
  drop column collections,
  drop column actions;

-- Only pairs the grant model knows: a collection key, one of its six
-- delegable actions, no null and at least one pair. The whole list is matched
-- as one string because a check constraint cannot read a subquery, so no pair
-- may hold whitespace: 'task:read task:write' as one element would otherwise
-- read as two.
alter table public.delegations
  add constraint delegations_pairs_known check (
    cardinality(pairs) > 0
    and array_position(pairs, null) is null
    and array_to_string(pairs, '') !~ '\s'
    and array_to_string(pairs, ' ') ~
      '^[a-z][a-z0-9_]{0,62}:(read|comment|write|assign|share|manage)( [a-z][a-z0-9_]{0,62}:(read|comment|write|assign|share|manage))*$'
  );

-- I07, in the schema, as 0008's `delegations_never_decide` said it of the
-- actions list: no pair carries `decide`. `delegations_pairs_known` refuses it
-- as well and sorts first; this one says why.
alter table public.delegations
  add constraint delegations_pairs_never_decide check (
    array_to_string(pairs, ' ') !~ ':decide( |$)'
  );

-- The pairs are fixed at mint. An update that added one would be the widening
-- this migration exists to prevent, written somewhere other than the mint.
create function public.delegations_pairs_are_fixed() returns trigger
  language plpgsql
  as $$
begin
  if new.pairs is distinct from old.pairs then
    raise exception 'delegations: the pairs are fixed at mint'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.delegations_pairs_are_fixed() from public;

create trigger delegations_pairs_are_fixed
  before update on public.delegations
  for each row execute function public.delegations_pairs_are_fixed();
