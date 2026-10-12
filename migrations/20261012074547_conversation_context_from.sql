-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Where a conversation's context starts. A purge of the task a conversation
-- was opened on keeps the conversation and its messages, and drops its scope
-- (`packages/core-records/src/tasks/trash.ts`); it now also sets
-- `context_from` to the purge's time. The earlier messages a model is sent
-- with the next question (`contextOf`,
-- `packages/core-commands/src/commands/conversation-context.ts`) are only
-- those created at or after it, so a question asked about the purged task,
-- before it had a client, is never sent again. Null, every conversation
-- before this and every one never purged under, sends all of them as before.
-- No function is added; `conversations` keeps its forced row security.

alter table public.conversations add column context_from timestamptz;
