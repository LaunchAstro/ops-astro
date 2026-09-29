// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 skeleton for the red run: signatures only, built in the next commit.

export type DataClass = 'business_internal' | 'client_scoped' | 'free_text' | 'personal';
export type FieldSource =
  'business_internal' | 'client_row' | 'client_person' | 'guest' | 'outside';
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

export function effectiveClass(
  _declared: Readonly<Record<string, DataClass>>,
  _field: PromptField,
): DataClass {
  throw new Error('AW-01: not built');
}

export function eligibleRoutes(
  _declared: Readonly<Record<string, DataClass>>,
  _fields: readonly PromptField[],
  _routes: readonly ModelRoute[],
): RouteChoice {
  throw new Error('AW-01: not built');
}

export const LOCAL_MODEL_REQUIRED_WORDS =
  'This waits on a local model: personal information stays out of cloud AI until a local model exists.';
