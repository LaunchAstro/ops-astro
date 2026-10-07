// SPDX-License-Identifier: AGPL-3.0-only
//
// The comment record type's fields, apart from the type's classifications and
// projection (`comments.ts`), so each file stays within its length.

import type { SpineField } from './spine.ts';

/**
 * The comment spine.
 *
 * `comment_type` and `audience` are two fields rather than one because they
 * answer two questions: a `system` comment can be addressed to a client, and a
 * `client` comment written in error can be re-addressed internally without
 * rewriting what it is. Collapsing them would make "who sees this" a property
 * of "what this is", which is the coupling that produces a leak when a new
 * kind arrives.
 */
export const COMMENT_SPINE: readonly SpineField[] = [
  {
    key: 'task',
    label: 'Task',
    valueType: 'uuid',
    slot: 'uuid_1',
    // The parent is established when the comment is written and never edited:
    // moving a comment between tasks is a different operation with a different
    // audit meaning, not a field edit.
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'author',
    label: 'Author',
    valueType: 'uuid',
    slot: 'uuid_2',
    // Derived from the acting identity. Never a payload field, because a
    // comment whose author a caller can set is not evidence of anything.
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'comment_type',
    label: 'Kind',
    valueType: 'text',
    slot: 'txt_1',
    writeMode: 'operation',
    owningOperations: ['task.comment'],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'audience',
    label: 'Audience',
    valueType: 'text',
    slot: 'txt_2',
    // Two operations: the one that writes the comment, and the one that
    // changes who a task's correspondence is addressed to. A generic edit to
    // this field is the access change that looks like ordinary content, which
    // is exactly what `write_mode` exists to catch.
    writeMode: 'operation',
    owningOperations: ['task.comment', 'task.set_audience'],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'body',
    label: 'Comment',
    valueType: 'text',
    slot: 'txt_3',
    writeMode: 'operation',
    // Its author rewrites it (CS-4.34); nobody else does, which is the
    // handler's check, not the field's.
    owningOperations: ['task.comment', 'task.edit_comment'],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'posted_at',
    label: 'Posted',
    valueType: 'timestamptz',
    slot: 'ts_1',
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'edited_at',
    label: 'Edited',
    valueType: 'timestamptz',
    slot: 'ts_2',
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'parent',
    label: 'Reply to',
    valueType: 'uuid',
    slot: 'uuid_3',
    // The top-level message a reply sits under, one level deep (R42), set
    // when the reply is written and never edited. Shared: a reply goes to
    // its message's audience, so a client is only ever shown the id of a
    // client message.
    writeMode: 'operation',
    owningOperations: ['task.comment'],
    escalatingOperation: null,
    visibilityClass: 'shared',
  },
  {
    key: 'conversation',
    label: 'Conversation',
    valueType: 'uuid',
    slot: 'uuid_4',
    // The team conversation a message sits in (C71), in place of a task:
    // set when it is written and never edited, like `task`. Internal.
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'source',
    label: 'Source',
    valueType: 'text',
    slot: 'txt_4',
    // Which surface it arrived through. Internal: it tells an outside reader
    // about the shape of the system rather than about the work.
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
  {
    key: 'on_behalf_of',
    label: 'On behalf of',
    valueType: 'uuid',
    // In `data` only: nothing filters on it.
    slot: null,
    // The person an agent's delegation acted for when it wrote the comment,
    // from that delegation (or an agent credential's person) and never the
    // payload; absent on a person's own.
    // One agent actor writes for many people, so its actor alone does not say
    // whose words these are (OW-036.1).
    writeMode: 'system',
    owningOperations: [],
    escalatingOperation: null,
  },
];
