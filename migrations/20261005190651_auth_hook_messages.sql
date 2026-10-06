-- SPDX-License-Identifier: AGPL-3.0-only
-- A UTC timestamp ID (docs/local/DATA.md, "What the schema is").
--
-- 20261004103712 a Send Email hook message sends once, installation-wide (C39-T).
-- The login provider's hook (`apps/api/auth-email-hook.ts`) looks for the
-- message's address in every business, each in its own transaction, and
-- sends the one pending invitation it finds. Two hook processes taking the
-- same signed message while invitations are made could each find a
-- different business's invitation, and a business's attempt rows cannot
-- show another business's send under row security: one message, two
-- emails and two tokens.
--
-- So the send claims the message here, in the same transaction as its token
-- and attempt and before them: one row per message id, as a SHA-256 digest
-- of the id. The primary key is the claim. A second claim of the same id
-- waits on the first's transaction and, once it commits, is refused, and
-- that send mints, records and sends nothing. A refused send makes no claim,
-- so it never holds a message.
--
-- The row is the digest and nothing else: no business, person, address or
-- invitation, so it says nothing about anyone to a caller who could read it.
-- The application group may insert and read it; it changes and removes
-- nothing. A message id stays claimed.

create table ops.auth_hook_messages (
  message_digest text primary key check (message_digest ~ '^[0-9a-f]{64}$')
);
revoke all on ops.auth_hook_messages from public;
grant select, insert on ops.auth_hook_messages to ops_astro_app;
