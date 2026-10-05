// SPDX-License-Identifier: AGPL-3.0-only
//
// A route's parameters and its resolved address, typed off the registry in
// `routes.ts`, which re-exports them. Types only, so nothing here runs.

import type { ROUTES, RouteId } from './routes.ts';

type Route<Id extends RouteId> = (typeof ROUTES)[Id];

/** The `:name` parameters a path declares, read off the path itself. */
type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;

/** A route's parameters, decoded: one string for each `:name` in its path. */
export type ParamsOf<Id extends RouteId> = {
  readonly [Name in ParamNames<Route<Id>['path']>]: string;
};

/** A route whose address has no parameters, so it can be linked to bare. */
export type StaticRouteId = {
  [Id in RouteId]: [keyof ParamsOf<Id>] extends [never] ? Id : never;
}[RouteId];

/** A resolved address: the route, its id, and its parameters typed by route. */
export type RouteMatch<Id extends RouteId = RouteId> = {
  [Each in Id]: {
    readonly id: Each;
    readonly route: Route<Each>;
    readonly params: ParamsOf<Each>;
  };
}[Id];
