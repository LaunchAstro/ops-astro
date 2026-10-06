// SPDX-License-Identifier: AGPL-3.0-only
//
// Team chat's data effects (C71-D, C71-G), spread into `COMMAND_EFFECTS` (moved whole for the line cap).

import type { CommandName } from './command-names.ts';
import { client, writing, type DataEffects } from './data-effects-types.ts';

const READ = writing([]);

export const CHAT_EFFECTS: {
  readonly [Name in Extract<CommandName, `chat.${string}`>]: DataEffects;
} = {
  // C71-D: the message is a comment record, its conversation a record beside
  // it with its two members; the marker is the reader's own member row. Both
  // tables are the records table's scope, as a task comment's is.
  'chat.send_direct': writing(client('records', 'team_conversation_members')),
  'chat.conversations': READ,
  'chat.messages': READ,
  'chat.mark_read': writing(client('team_conversation_members')),
  // C71-G: a group is a record with its members; a message a comment record
  // and the sender's marker; a rename its record; a change or a leave rows.
  'chat.start_group': writing(client('records', 'team_conversation_members')),
  'chat.send_group': writing(client('records', 'team_conversation_members')),
  'chat.rename_group': writing(client('records')),
  'chat.change_members': writing(client('team_conversation_members')),
  'chat.leave': writing(client('team_conversation_members')),
};
