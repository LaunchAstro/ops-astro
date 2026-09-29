// SPDX-License-Identifier: AGPL-3.0-only
//
// Owner line 72: personal information stays out of cloud AI until a local
// model exists, and a local model never makes it eligible for the cloud.
//
// Every field of an outbound prompt carries a data class, declared in its
// operation's reviewed registration. The class is fail-closed:
//
// - `business_internal` is the one class a cloud route may carry, and only
//   when the field's source is business-internal too: no client key, not
//   entered by a client person, a guest or an outside source.
// - `client_scoped` (anything read from a row carrying a client key, and any
//   image, audio or video of a client), `free_text` (task text, briefs, code,
//   comments, any string) and `personal` go only to a local route.
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
}

export interface PromptField {
  readonly name: string;
  readonly source: FieldSource;
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

/**
 * The routes this prompt may take, chosen before any route is: all of them when
 * every field is business-internal, else the local ones only, else a refusal.
 * A field the operation does not declare is personal.
 */
export function eligibleRoutes(
  declared: Readonly<Record<string, DataClass>>,
  fields: readonly PromptField[],
  routes: readonly ModelRoute[],
): RouteChoice {
  const staysLocal = fields
    .filter((field) => effectiveClass(declared, field) !== 'business_internal')
    .map((field) => field.name);
  if (staysLocal.length === 0) return { ok: true, routes };
  const local = routes.filter((route) => route.reach === 'local');
  if (local.length === 0) return { ok: false, code: 'LOCAL_MODEL_REQUIRED', fields: staysLocal };
  return { ok: true, routes: local };
}

/** The plain words a refused call records as its step. */
export const LOCAL_MODEL_REQUIRED_WORDS =
  'This waits on a local model: personal information stays out of cloud AI until a local model exists.';
