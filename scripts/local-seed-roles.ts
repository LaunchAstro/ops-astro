// SPDX-License-Identifier: AGPL-3.0-only
//
// The local seed's role grants (`scripts/local-seed.mjs`), in a module of their
// own. The seed runs on import, so a test could not import the table from it;
// this file only declares the table, and the seed and the tests both import it.

import type { Action } from '../packages/core-records/src/authority/grants.ts';

/** What a role may do when the file names no grants of its own. */
export const GRANTS_BY_ROLE: Readonly<
  Record<'admin' | 'member' | 'none' | 'external', readonly (readonly [string, Action])[]>
> = {
  admin: [
    ['task', 'read'],
    ['task', 'write'],
    ['task', 'assign'],
    ['task', 'comment'],
    ['task', 'share'],
    ['task', 'manage'],
    ['person', 'read'],
    // The settings commands took `manage` on the `settings` collection
    // (`core-wire/src/surface.ts`), and the admin had six task actions and
    // `person:read`, so as seeded nobody could write either setting: WEB-COMMENTS
    // observed `POST /settings/set_four_eyes_threshold` as the admin answering
    // 403 SCOPE_NOT_GRANTED against the live stack. A setting that decides who
    // must agree before money moves is an authority change, and an
    // administrator is who the model means by whoever may make it.
    ['settings', 'manage'],
    // A decision draws on the business's budget cap and signs a link into the
    // append-only decision chain, which is the same class of act as the
    // `settings` grant above. `core-wire/src/surface.ts` declares `task.decide`
    // with the action `decide`, and `authority/grants.ts` matches the
    // collection and the action exactly -- there is no implication, so
    // `task:manage` never covered it. As seeded before this line no identity
    // held `task:decide` at all, so `task.decide` answered 403
    // SCOPE_NOT_GRANTED for every synthetic user and the runtime journey could
    // not be walked over HTTP: the same shape as the `settings:manage` gap.
    ['task', 'decide'],
    // AW-05's answers at the budget stop (`core-wire/src/surface.ts`): a
    // top-up is `decide` on `billing` (T2e's pair, below) and the one-click
    // end `decide` on `gate`, each a person's act. The same gap as the two
    // above: without it no synthetic user could end a run waiting at its ceiling.
    ['gate', 'decide'],
    // Settings are business facts, and a reader is not a writer. The write
    // stays `manage` above; this is the half that lets a screen show the
    // four-eyes band instead of guessing at it.
    ['settings', 'read'],
    // A top-up is a money decision on `billing` (T2e, the permission
    // catalogue's `billing:decide`): the owner and administrators hold it.
    ['billing', 'decide'],
    // Custody (C31): the key catalogue gives `custody:manage` to the owner and
    // administrators, never an agent. Without it no seeded identity could set
    // or clear a key on Settings ▸ Keys.
    ['custody', 'manage'],
    // The connector fleet on Connections & signal (MP-14-7a).
    ['connection', 'read'],
    // What agent runs cost (MP-14-9, MP-14-6): the key catalogue's `finance:read`.
    ['finance', 'read'],
    // Standing mandates and graduation (MP-14-10a): filing, revoking,
    // promoting and demoting are `mandate:manage`, the owner's and
    // administrators' and never an agent's; a money key, so C59's step-up.
    ['mandate', 'manage'],
    // A person's own conversations with the agent (AW-03): the owner and
    // administrators hold `conversation:write` (the permission key catalogue).
    // `conversation:read`, the read-any grant, is seeded to nobody: it is given
    // to a named person on purpose, never held by a role on install.
    ['conversation', 'write'],
    // MP-6-2's `state revised` (ORCH33, ORCH38): `run:write`, a person's own
    // and an agent's inside its delegation; the owner and administrators hold it.
    ['run', 'write'],
    // Client access (MP-4-10) shares a task with its client's people under
    // `access:share`, which the key catalogue gives the owner and
    // administrators and never an agent.
    ['access', 'share'],
    // Time tracking (MP-4-6) asks `time:write`: the owner's and
    // administrators', and a member's only where granted.
    ['time', 'write'],
    // Tags (MP-4-11) ask `tag:write` for a new name in the vocabulary.
    ['tag', 'write'],
    // Settings ▸ Access (C32): the owner and administrators hold
    // `access:manage` on install (the key catalogue's default holders).
    ['access', 'manage'],
    // The operations view and the privacy incident record (C55): the owner
    // and administrators hold both on install, and no agent ever does.
    // `inbox.unattended` asks `operations:read` too (INB-1e), and it names
    // other people's items.
    ['operations', 'read'],
    ['privacy', 'manage'],
    // An agent credential of their own (API-2): the owner and administrators
    // hold `credential:write` on install.
    ['credential', 'write'],
    // The client record (C32): the owner and administrators make clients.
    ['record', 'write'],
    // The four-eyes threshold is a money action (MP-2-11, owner line 71):
    // `spend:decide`, so C59's step-up judges it. Client sign-off and the
    // step-up switch stay `settings:manage` above.
    ['spend', 'decide'],
    // Team conversations (C71-D): `chat:comment`, an agency member's key;
    // within a conversation the query holds it to its members.
    ['chat', 'comment'],
    // Group conversations (C71-G): `chat:manage`, a group's creator's and the
    // owner's and administrators', renames one and changes its members.
    ['chat', 'manage'],
    // Settings ▸ Workflow triggers (C33): releasing a definition version is
    // `automation:manage`, the owner's and administrators' and never an agent's.
    ['automation', 'manage'],
    // The review workspace (C35, #2011): opening a review, asking its captures and
    // reading them are `review:write` and `review:read`, the owner's and administrators'.
    ['review', 'write'],
    ['review', 'read'],
    ['review', 'comment'],
    // A client pin filed as a change request and decided (C57, #2016): `proposal:write`
    // and `proposal:decide`, the owner's and administrators'.
    ['proposal', 'write'],
    ['proposal', 'decide'],
  ],
  member: [
    ['task', 'read'],
    ['task', 'write'],
    ['task', 'assign'],
    ['person', 'read'],
    // Every member may see what the business decided about itself. A member
    // who cannot read the four-eyes band cannot tell a refusal from a bug when
    // their own work stops at a second approver. The write is the admin's:
    // `settings:manage` is not widened by this line.
    ['settings', 'read'],
    // Team conversations (C71-D): `chat:comment` is every agency member's
    // key (the catalogue's default holders), not the administrators' alone.
    ['chat', 'comment'],
  ],
  none: [],
  // The external party holds no business grant, and must not: a person with no
  // membership and a live business grant is refused at resolution as a former
  // member. What it may read is what `shareRecord` shares with it, in `local-seed.mjs`.
  external: [],
};
