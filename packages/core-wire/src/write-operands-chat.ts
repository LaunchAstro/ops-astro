// SPDX-License-Identifier: AGPL-3.0-only
//
// Team chat's write operands (C71-D, C71-G). Spread into `WRITE_OPERANDS` in
// `write-operands.ts`, whose type checks every operand; nothing is imported
// back, so no cycle (moved whole for the line cap).

export const CHAT_OPERANDS = {
  'chat.send_direct': { teammateId: 'id', body: 'any' },
  'chat.mark_read': { conversationId: 'id', upTo: 'any' },
  // C71-G: a group's name and its people are checked by value by the handler.
  'chat.start_group': { name: 'any', members: 'any' },
  'chat.send_group': { conversationId: 'id', body: 'any' },
  'chat.rename_group': { conversationId: 'id', name: 'any' },
  'chat.change_members': { conversationId: 'id', add: 'any?', remove: 'any?' },
  'chat.leave': { conversationId: 'id' },
} as const;
