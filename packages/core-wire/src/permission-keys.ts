// SPDX-License-Identifier: AGPL-3.0-only
//
// The permission keys a grant may carry (C32): each `collection:action` of the
// permission key catalogue (ops-astro-roadmap `CAPABILITY-SLICES.md`, FU-1-KEYS,
// 27 September 2026), and each pair the command surface already checks that the
// catalogue does not list (the reads' `task:read`, `person:read`,
// `settings:read`, `session:read`, and `preset:manage`). A key added to the
// catalogue is added here in the same change.
//
// Three keys are self-scoped: every signed-in person holds them on their own
// account, credentials or preferences and nobody holds them on another's, so
// they are never granted (`account:write`, `credential:write`,
// `preference:write`).

const CATALOGUE: Readonly<Record<string, readonly string[]>> = {
  access: ['manage', 'share'],
  automation: ['decide', 'manage'],
  billing: ['decide', 'manage', 'write'],
  chat: ['comment', 'manage'],
  connection: ['write'],
  conversation: ['read', 'write'],
  custody: ['manage'],
  docs: ['decide', 'write'],
  experiment: ['decide', 'write'],
  export: ['read'],
  finance: ['read'],
  form: ['decide', 'share', 'write'],
  gate: ['decide'],
  inbox: ['write'],
  library: ['write'],
  mandate: ['manage'],
  meeting: ['write'],
  offer: ['decide', 'share'],
  operations: ['manage', 'read'],
  person: ['read'],
  preset: ['manage'],
  privacy: ['manage'],
  proposal: ['comment', 'decide', 'write'],
  record: ['decide', 'manage', 'share', 'write'],
  report: ['read', 'share', 'write'],
  review: ['comment', 'decide', 'manage', 'read', 'share', 'write'],
  run: ['write'],
  session: ['read'],
  settings: ['decide', 'manage', 'read', 'write'],
  skill: ['decide', 'manage', 'read', 'write'],
  spend: ['decide'],
  tag: ['write'],
  task: ['assign', 'comment', 'decide', 'manage', 'read', 'share', 'write'],
  time: ['write'],
};

export const SELF_SCOPED_COLLECTIONS: readonly string[] = ['account', 'credential', 'preference'];

/** Whether a collection is one a grant may name. */
export function isGrantableCollection(collection: string): boolean {
  return Object.hasOwn(CATALOGUE, collection);
}

/** Whether `collection:action` is a key a grant may carry. */
export function isGrantableKey(collection: string, action: string): boolean {
  return isGrantableCollection(collection) && (CATALOGUE[collection] ?? []).includes(action);
}
