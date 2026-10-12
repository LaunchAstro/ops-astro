-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Which messages a conversation's context still carries, as an ordering
-- rather than a clock. A purge of the task a conversation was opened on keeps
-- the conversation and its messages and drops its scope
-- (`packages/core-records/src/tasks/trash.ts`). It now also bumps
-- `conversations.context_epoch`, under the conversation's row lock. Every
-- question and reply takes that same lock before it is written, and records
-- the epoch it was written under in `conversation_messages.context_epoch`.
-- The earlier messages a model is sent with the next question (`contextOf`,
-- `packages/core-commands/src/commands/conversation-context.ts`) are only
-- those of the current epoch, a reply only when its question is too. A
-- message written before the purge took the lock is cut, however the
-- transactions' clocks fall.
--
-- Every existing row starts at 0, which is every conversation's epoch until
-- its first purge, so nothing already sent changes. No function is added;
-- both tables keep their forced row security.

alter table public.conversations add column context_epoch integer not null default 0;
alter table public.conversation_messages add column context_epoch integer not null default 0;
