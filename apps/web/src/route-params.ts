// SPDX-License-Identifier: AGPL-3.0-only
//
// A route's parameters and its resolved address, typed off a route table.
// `routes.ts` names them over its own registry. The table is a type
// parameter, so this file imports nothing and the two never form a cycle.
// Types only, so nothing here runs.

/** A route table: each id's route, with at least its path. */
export type RouteTable = Readonly<Record<string, { readonly path: string }>>;

/** The `:name` parameters a path declares, read off the path itself. */
type ParamNames<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<Rest>
  : Path extends `${string}:${infer Name}`
    ? Name
    : never;

/** A route's parameters, decoded: one string for each `:name` in its path. */
export type ParamsIn<Table extends RouteTable, Id extends keyof Table> = {
  readonly [Name in ParamNames<Table[Id]['path']>]: string;
};

/** A route whose address has no parameters, so it can be linked to bare. */
export type StaticIn<Table extends RouteTable> = {
  [Id in keyof Table]: [keyof ParamsIn<Table, Id>] extends [never] ? Id : never;
}[keyof Table];

/** A resolved address: the route, its id, and its parameters typed by route. */
export type MatchIn<Table extends RouteTable, Id extends keyof Table> = {
  [Each in Id]: {
    readonly id: Each;
    readonly route: Table[Each];
    readonly params: ParamsIn<Table, Each>;
  };
}[Id];
