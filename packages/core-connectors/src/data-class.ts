// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72: personal information stays out of cloud AI until a local
// model exists, and a local model never makes it eligible for the cloud.
// The decision is ops-astro-roadmap `docs/decisions/execution.md`, the
// owner's line 72 entry (28 September 2026) and its direction of 13 October
// 2026: work with no personal information in it (task text, briefs, code) may
// use the owner's own seats, judged by where it came from.
//
// Every field of an outbound prompt carries a data class, declared in its
// operation's reviewed registration. The class is fail-closed:
//
// - `business_internal` may take any cloud route, and only when the field's
//   source is business-internal too: no client key, not entered by a client
//   person, a guest or an outside source.
// - `free_text` (task text, briefs, code, comments, any string) goes only to a
//   local route, save one case: the broker found it is the owner's own work
//   (`ownerWork`: the owner started the task, it has no client key, and
//   nothing on it was typed by a client or written by an agent). That text may
//   also take a cloud route carried by a subscription, the owner's own seat,
//   and never one carried by an API key or a cloud credential.
// - `client_scoped` (anything read from a row carrying a client key, and any
//   image, audio or video of a client) and `personal` go only to a local route.
// - A field with no class, a class this module does not know, or a class that
//   does not match its source is treated as `personal`.
//
// With no local route configured, a call carrying such a field is refused
// before any route is chosen (`LOCAL_MODEL_REQUIRED`).

export type DataClass = 'business_internal' | 'client_scoped' | 'free_text' | 'personal';

/** Where a field's value was read from. Anything but `business_internal` may hold personal information. */
export type FieldSource =
  'business_internal' | 'client_row' | 'client_person' | 'guest' | 'outside';

/** Whether a route keeps the content on the business's own machine. A replay route stands for a cloud one. */
export type RouteReach = 'local' | 'cloud';

export interface ModelRoute {
  readonly key: string;
  readonly reach: RouteReach;
  /** What carries a cloud route; only `subscription` is the owner's own seat. */
  readonly credentialKind?: string;
}

export interface PromptField {
  readonly name: string;
  readonly source: FieldSource;
  /** Set only by the broker, from rows: the owner's own work, with no client in it. */
  readonly ownerWork?: boolean;
}

export type RouteChoice =
  | { readonly ok: true; readonly routes: readonly ModelRoute[] }
  | {
      readonly ok: false;
      readonly code: 'LOCAL_MODEL_REQUIRED';
      readonly fields: readonly string[];
    };

/** The class the broker acts on: the declared one only when it is known and agrees with the source. */
export function effectiveClass(
  declared: Readonly<Record<string, DataClass>>,
  field: PromptField,
): DataClass {
  const named = Object.hasOwn(declared, field.name) ? declared[field.name] : undefined;
  switch (named) {
    case 'business_internal':
      return field.source === 'business_internal' ? 'business_internal' : 'personal';
    case 'client_scoped':
    case 'free_text':
      return named;
    default:
      return 'personal';
  }
}

/** Whether `route` may carry `field`: a local route any field, a cloud route by the field's class. */
function carries(
  declared: Readonly<Record<string, DataClass>>,
  field: PromptField,
  route: ModelRoute,
): boolean {
  if (route.reach === 'local') return true;
  const kind = effectiveClass(declared, field);
  if (kind === 'business_internal') return true;
  return (
    kind === 'free_text' &&
    field.source === 'business_internal' &&
    field.ownerWork === true &&
    route.credentialKind === 'subscription'
  );
}

/**
 * The routes this prompt may take, chosen before any route is: those that may
 * carry every field, else a refusal naming the fields that are not
 * business-internal. A field the operation does not declare is personal.
 */
export function eligibleRoutes(
  declared: Readonly<Record<string, DataClass>>,
  fields: readonly PromptField[],
  routes: readonly ModelRoute[],
): RouteChoice {
  const eligible = routes.filter((route) =>
    fields.every((field) => carries(declared, field, route)),
  );
  if (eligible.length > 0) return { ok: true, routes: eligible };
  const staysLocal = fields
    .filter((field) => effectiveClass(declared, field) !== 'business_internal')
    .map((field) => field.name);
  return { ok: false, code: 'LOCAL_MODEL_REQUIRED', fields: staysLocal };
}

/** The plain words a refused call records as its step. */
export const LOCAL_MODEL_REQUIRED_WORDS =
  'This waits on a local model: personal information stays out of cloud AI until a local model exists.';
