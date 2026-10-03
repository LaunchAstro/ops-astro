// SPDX-License-Identifier: AGPL-3.0-only
//
// Team conversations, the group half (C71-G, CS-7.41), on C71-D's rows
// (`core-records/src/team/groups.ts`). Each command is audited by its
// envelope in this transaction, recording that it ran and never a message or
// a name. Staff only: a client's person and an agent are never a member, and
// any name that is not staff here gets the one NOT_FOUND.
//
// - `chat.start_group`: `chat:comment`, asked by the envelope; a name and two
//   or more teammates, the creator not among them. `conversation started
//   (audience: group)`.
// - `chat.send_group`: a member's message, through `writeMessage`, the one
//   path a direct message takes too. `comment created (audience: group)`.
// - `chat.rename_group`, `chat.change_members`: its creator while a member,
//   or a holder of `chat:manage` (the owner and administrators), in it or
//   not; a member who is neither gets the grant refusal, anyone else outside
//   it NOT_FOUND. They change the name and who else is in it, so a manager
//   outside it learns who is in it from the answers, never a message.
//   `conversation renamed`, `conversation members changed`.
// - `chat.leave`: the person's own membership, no grant asked.
//
// Every one of them takes the conversation's lock before it reads who is in
// it (`lockGroup`), so sends, member changes and leaves serialise there.

import {
  allStaff,
  changeGroupMembers,
  checkAuthority,
  GROUP_NAME_LIMIT,
  groupNameOf,
  lockGroup,
  renameGroup,
  startGroup,
  subjectsOf,
  type ConversationTypes,
  type GroupMembership,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import { isInternalReader } from '../reads/tasks.ts';
import type { CommandContext } from './context.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { conversationTypesFor, writeMessage } from './chat.ts';
import { commentBodyOf, mentionsOf } from './tasks-comment.ts';

/** More people than a team conversation is for; past it, the list is refused. */
const MEMBER_LIMIT = 100;

const NAME_FIXES: readonly string[] = [
  `Send name as text of 1 to ${String(GROUP_NAME_LIMIT)} characters, with no control character.`,
];
const MEMBERS_FIXES: readonly string[] = [
  'Send members as a list of two or more teammates’ person ids, each once, yourself not among them.',
];
const CHANGE_FIXES: readonly string[] = [
  'Send add, remove or both as lists of person ids: add people not in it, remove people in it, yourself in neither.',
  'To leave a conversation yourself, send chat.leave.',
];

function invalid(field: string, fixes: readonly string[]): HandlerOutcome {
  return refused(refuseCommand('FIELD_VALUE_INVALID', [field], fixes));
}

/** A list of distinct person ids, lower-cased; undefined for anything else. */
function peopleOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MEMBER_LIMIT) return undefined;
  if (!value.every((one) => typeof one === 'string')) return undefined;
  const people = (value as readonly string[]).map((one) => one.toLowerCase());
  return new Set(people).size === people.length ? people : undefined;
}

type Locked =
  | { readonly types: ConversationTypes; readonly group: GroupMembership }
  | { readonly refusal: HandlerOutcome };

/** The types and a live group of this business, locked; or NOT_FOUND. */
async function lockedGroup(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
): Promise<Locked> {
  const types = await conversationTypesFor(tx, context);
  if (!('conversationTypeId' in types)) return { refusal: types };
  const group = await lockGroup(tx, types, conversationId);
  return group === undefined ? { refusal: refused(refuseNotFound()) } : { types, group };
}

/** The caller's own group, locked: a current member's; to anyone else NOT_FOUND. */
async function ownGroup(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
): Promise<Locked> {
  const found = await lockedGroup(tx, context, conversationId);
  if ('refusal' in found || found.group.members.includes(context.session.personId)) return found;
  return { refusal: refused(refuseNotFound()) };
}

/**
 * A group the caller may rename or change the members of, locked: its creator
 * while a member, or a holder of `chat:manage` over the business, in it or
 * not. A member who is neither gets the grant refusal; anyone else outside it
 * NOT_FOUND, as for a group never issued.
 */
async function managedGroup(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
): Promise<Locked> {
  const found = await lockedGroup(tx, context, conversationId);
  if ('refusal' in found) return found;
  const { session } = context;
  const member = found.group.members.includes(session.personId);
  if (member && found.group.creator === session.personId) return found;
  const asked = await checkAuthority(tx, subjectsOf(session), {
    collection: 'chat',
    action: 'manage',
    scope: { kind: 'business', id: null },
  });
  if (asked.ok) return found;
  return { refusal: refused(member ? asked.refusal : refuseNotFound()) };
}

export async function startGroupConversation(
  tx: TenantQuery,
  context: CommandContext,
  name: unknown,
  members: unknown,
): Promise<HandlerOutcome> {
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(refuseNotFound());
  const named = groupNameOf(name);
  if (named === undefined) return invalid('name', NAME_FIXES);
  const teammates = peopleOf(members);
  if (teammates === undefined || teammates.length < 2 || teammates.includes(session.personId)) {
    return invalid('members', MEMBERS_FIXES);
  }
  const types = await conversationTypesFor(tx, context);
  if (!('conversationTypeId' in types)) return types;
  if (!(await allStaff(tx, teammates))) return refused(refuseNotFound());
  const conversationId = await startGroup(tx, types, session.personId, named, teammates);
  return applied(conversationId, null, { conversationId });
}

export async function sendGroupMessage(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
  body: unknown,
  mentions?: unknown,
): Promise<HandlerOutcome> {
  if (!isInternalReader(context.session.roleKey)) return refused(refuseNotFound());
  const words = commentBodyOf(body);
  if (typeof words !== 'string') return words;
  const named = mentionsOf(mentions);
  if (!Array.isArray(named)) return named as HandlerOutcome;
  const own = await ownGroup(tx, context, conversationId);
  if ('refusal' in own) return own.refusal;
  return await writeMessage(tx, context, own.types, conversationId, 'group', words, named);
}

export async function renameGroupConversation(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
  name: unknown,
): Promise<HandlerOutcome> {
  if (!isInternalReader(context.session.roleKey)) return refused(refuseNotFound());
  const named = groupNameOf(name);
  if (named === undefined) return invalid('name', NAME_FIXES);
  const managed = await managedGroup(tx, context, conversationId);
  if ('refusal' in managed) return managed.refusal;
  await renameGroup(tx, conversationId, named);
  return applied(conversationId, null, { conversationId });
}

export async function changeGroupConversationMembers(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
  change: { readonly add?: unknown; readonly remove?: unknown },
): Promise<HandlerOutcome> {
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(refuseNotFound());
  const add = change.add === undefined ? [] : peopleOf(change.add);
  const remove = change.remove === undefined ? [] : peopleOf(change.remove);
  if (add === undefined) return invalid('add', CHANGE_FIXES);
  if (remove === undefined || remove.includes(session.personId)) {
    return invalid('remove', CHANGE_FIXES);
  }
  if (add.length + remove.length === 0 || add.some((one) => remove.includes(one))) {
    return invalid('add', CHANGE_FIXES);
  }
  const managed = await managedGroup(tx, context, conversationId);
  if ('refusal' in managed) return managed.refusal;
  const { members } = managed.group;
  if (add.some((one) => one === session.personId || members.includes(one))) {
    return invalid('add', CHANGE_FIXES);
  }
  if (!remove.every((one) => members.includes(one))) {
    return refused(refuseNotFound());
  }
  if (!(await allStaff(tx, add))) return refused(refuseNotFound());
  await changeGroupMembers(tx, conversationId, { add, remove });
  return applied(conversationId, null, { conversationId });
}

export async function leaveGroupConversation(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: string,
): Promise<HandlerOutcome> {
  const { session } = context;
  if (!isInternalReader(session.roleKey)) return refused(refuseNotFound());
  const own = await ownGroup(tx, context, conversationId);
  if ('refusal' in own) return own.refusal;
  await changeGroupMembers(tx, conversationId, { add: [], remove: [session.personId] });
  return applied(conversationId, null, { conversationId });
}
