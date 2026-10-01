-- SPDX-License-Identifier: AGPL-3.0-only
--
-- 0214 the receipt link (AW-08). An observed effect's link to the result where
-- it is live, captured from the provider's answer when the effect is observed
-- and kept only when it is https on the operation's declared host
-- (`core-runtime/src/receipt-link.ts`). Null is absent: none given, or one that
-- was not kept. The column checks the shape again, so no write path can store
-- another scheme, a user, a query or a fragment.
--
-- It is written once, in the statement that records the observation, and never
-- after: a link resolved later is not a receipt, and the receipt carries no
-- operation that could undo the effect.

alter table public.attempts add column receipt_link text;

alter table public.attempts add constraint attempts_receipt_link_shape check (
  receipt_link is null
  or (observed
      and char_length(receipt_link) <= 512
      and receipt_link ~ '^https://[a-z0-9.-]+/[A-Za-z0-9._~%!$&''()*+,;=:@/-]*$')
);

create function public.attempts_receipt_link_once() returns trigger
  language plpgsql
  as $$
begin
  if new.receipt_link is distinct from old.receipt_link and old.observed then
    raise exception 'attempt % is observed, and its receipt link is fixed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.attempts_receipt_link_once() from public;

create trigger attempts_receipt_link_once
  before update of receipt_link on public.attempts
  for each row execute function public.attempts_receipt_link_once();
