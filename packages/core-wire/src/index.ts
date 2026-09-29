// SPDX-License-Identifier: AGPL-3.0-only
//
// The wire contract's one way in: the command surface, every command and read
// with its path and prefix, which the API, the web and the command line all
// speak. It imports records for types only and nothing else of the product,
// so a browser bundle can load it without the database.

export {
  COMMAND_SURFACE,
  declarationOf,
  DELEGATION_HEADER,
  pathOf,
  PREFIX,
  READS,
  type CommandDeclaration,
  type CommandName,
} from './surface.ts';
// The one refusal shape, for the clients that parse it off the wire. Type-only,
// so no records code reaches a bundle.
export type { CommandRefusal } from '../../core-records/src/index.ts';
