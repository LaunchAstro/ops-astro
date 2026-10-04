-- SPDX-License-Identifier: AGPL-3.0-only
--
-- The receipt link column refuses a credential-length run (catalogue #429).
-- 0109's shape check admits a path holding a delegation credential: an
-- HMAC-SHA-256 in base64url, 43 characters of the column's own alphabet. The
-- worker's rule (`core-runtime/src/receipt-link.ts`, `CREDENTIAL_RUN`) records
-- such a link absent; this check refuses the same raw run at the column, so no
-- other write path can store one. The decoded and agent-specific spellings stay
-- the worker's: a column check reads neither.
--
-- 0109 stays byte-identical; its constraint is replaced by one that keeps every
-- term and adds the run. Adding it reads every stored row, so a link that would
-- break the rule stops the migration rather than staying stored.

alter table public.attempts drop constraint attempts_receipt_link_shape;

alter table public.attempts add constraint attempts_receipt_link_shape check (
  receipt_link is null
  or (observed
      and char_length(receipt_link) <= 512
      and receipt_link ~ '^https://[a-z0-9.-]+/[A-Za-z0-9._~%!$&''()*+,;=:@/-]*$'
      and receipt_link !~ '[A-Za-z0-9_-]{43}')
);
