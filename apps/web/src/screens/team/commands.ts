// SPDX-License-Identifier: AGPL-3.0-only
//
// The chat commands the Team screen sends, and a group's action as its command.
// Moved whole from `chat.ts` to keep that file under the line cap.

import type { GroupAction } from '@launchastro/ui';

export type ChatCommand =
  | 'chat.send_direct'
  | 'chat.send_group'
  | 'chat.mark_read'
  | 'chat.start_group'
  | 'chat.rename_group'
  | 'chat.change_members'
  | 'chat.leave';

/** A group's action as its chat command; members sends only the side that names someone. */
export function commandOf(action: GroupAction): readonly [ChatCommand, Record<string, unknown>] {
  switch (action.do) {
    case 'start':
      return ['chat.start_group', { name: action.name, members: action.members }];
    case 'rename':
      return ['chat.rename_group', { conversationId: action.id, name: action.name }];
    case 'members':
      return [
        'chat.change_members',
        {
          conversationId: action.id,
          ...(action.add.length > 0 ? { add: action.add } : {}),
          ...(action.remove.length > 0 ? { remove: action.remove } : {}),
        },
      ];
    case 'leave':
      return ['chat.leave', { conversationId: action.id }];
    case 'read':
      return ['chat.mark_read', { conversationId: action.id, upTo: action.upTo }];
    case 'send':
      return ['chat.send_group', { conversationId: action.id, body: action.body }];
  }
}
