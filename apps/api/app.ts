// SPDX-License-Identifier: AGPL-3.0-only
//
// The HTTP boundary. Hono receives a command, derives the actor and the
// business from trusted authentication, and calls the domain operation that
// owns the rule (`docs/platform-construction.md`, Web API).
//
// Ported from `ops-astro-t1-draft@60f2009 apps/api/app.ts`, with the business
// taken from the path and the read half of the surface added. Three things
// this file is careful not to be, all of them the draft's:
//
// It is not an authority. There is no permission check here and no record
// read: every refusal in a response came back from the operation, which is
// what "no authority check may live only in the transport layer" means.
//
// It is not a second surface shape. The routes are generated from
// `COMMAND_SURFACE`, so an operation cannot exist without an endpoint and an
// endpoint cannot exist without an operation. A declaration added by another
// part appears here with no edit to this file — which is the whole reason the
// loop reads the table rather than a list of its own.
//
// It is not a place a caller can reach the server's own facts. The actor, the
// business and the entry point are not fields in the request type, so a body
// carrying `actorId`, `businessId` or `entryPoint` is data with nowhere to go
// rather than a value something has to remember to ignore.
//
// **The business is named in the path and verified, never trusted** (N7). The
// prefix `/api/b/:businessKey` says which business the caller means; the
// server maps that key to an identifier and then login resolution decides
// whether this subject is a member of it. A key nobody is a member of and a
// key that does not exist refuse identically, for the same reason an unmapped
// subject and a missing login do: telling them apart tells an outsider which
// businesses exist.

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { VerifiedSubject } from '../../packages/core-records/src/identity/login-resolution.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import {
  isCommandRefusal,
  refuseCommand,
  type CommandRefusal,
} from '../../packages/core-records/src/commands/refusal.ts';
import {
  COMMAND_SURFACE,
  pathOf,
  type CommandDeclaration,
} from '../../packages/core-records/src/commands/surface.ts';
import type { CommandRequest } from '../../packages/core-records/src/commands/requests.ts';
import { statusFor } from './status.ts';

/**
 * The surface declaration as this boundary reads it.
 *
 * `kind` is SLICE-DATA's addition for the three read declarations the local
 * slice contract names (`task.read`, `task.board`, `person.list`). It is
 * optional here so that the boundary compiles and behaves correctly against a
 * surface that has not grown it yet: absent means the draft's original
 * meaning, which is that everything is a mutation.
 */
export type SurfaceDeclaration = CommandDeclaration & { readonly kind?: 'read' | 'write' };

export function isRead(declaration: SurfaceDeclaration): boolean {
  return declaration.kind === 'read';
}

/** A read, run under the same tenancy wrapper and the same grant path. */
export type ReadExecutor = (
  database: Database,
  businessId: string,
  presented: VerifiedSubject,
  request: { readonly command: string } & Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export interface ApiOptions {
  readonly database: Database;
  /**
   * Trusted authentication. It reads the request and returns the subject a
   * provider has verified, or nothing. It is the only way a caller's identity
   * enters the system, and it is passed in rather than chosen here so a
   * deployment cannot be talked into a second one.
   */
  readonly verify: (request: Context['req']) => Promise<VerifiedSubject | undefined>;
  /**
   * The business key from the path to the server's own identifier, or nothing
   * if there is no such business. Injected for the same reason `verify` is:
   * the boundary must not be able to read the tenancy root itself.
   */
  readonly resolveBusiness: (businessKey: string) => Promise<string | undefined>;
  /**
   * The read half of the surface. Absent until SLICE-DATA's reads land, and a
   * declared read with no executor refuses `DEPENDENCY_NOT_LANDED` rather than
   * 404 — the same answer the surface already gives for a command whose part
   * has not been built.
   */
  readonly executeRead?: ReadExecutor;
}

export function createApi(options: ApiOptions): Hono {
  const api = new Hono();
  const routes = new Hono();

  for (const declaration of COMMAND_SURFACE as readonly SurfaceDeclaration[]) {
    routes.post(pathOf(declaration.name), async (context) => {
      const presented = await options.verify(context.req);
      if (presented === undefined) {
        return refuse(context, refuseCommand('AUTH_UNKNOWN_LOGIN', [], [SIGN_IN]));
      }

      // The key comes from the path and is resolved by the server. A caller
      // who is not a member of the business they named gets the same refusal
      // as one who named a business that does not exist.
      const businessId = await options.resolveBusiness(context.req.param('businessKey') ?? '');
      if (businessId === undefined) {
        return refuse(context, refuseCommand('AUTH_NO_MEMBERSHIP', [], NO_BUSINESS));
      }

      const body = await readObject(context);
      if (body === undefined) {
        return refuse(context, refuseCommand('COMMAND_BODY_INVALID', [], [OBJECT]));
      }

      // The command comes from the route, never from the body, so a caller
      // cannot post to one endpoint and have another operation run.
      if (isRead(declaration)) {
        const execute = options.executeRead;
        if (execute === undefined) {
          return refuse(context, refuseCommand('DEPENDENCY_NOT_LANDED', [declaration.name], READS));
        }
        const read = await execute(options.database, businessId, presented, {
          ...body,
          command: declaration.name,
        });
        if (isObject(read) && isCommandRefusal(read)) return refuse(context, read);
        return context.json(read as Record<string, unknown>, 200);
      }

      const request = { ...body, command: declaration.name } as CommandRequest;
      const result = await executeCommand(options.database, businessId, presented, 'api', request);

      if (isCommandRefusal(result)) return refuse(context, result);
      return context.json({ ...result }, 200);
    });
  }

  api.route('/api/b/:businessKey', routes);
  return api;
}

/**
 * One way out for every refusal, so the ones the boundary raises itself go
 * through the register's constructor and the status table like any other. A
 * review of the draft found both of its own minting a code by hand.
 */
function refuse(context: Context, refusal: CommandRefusal): Response {
  return context.json(
    { code: refusal.code, names: refusal.names, fixes: refusal.fixes },
    statusFor(refusal.code),
  );
}

const SIGN_IN = 'Sign in. This endpoint reads the caller from verified authentication only.';
const OBJECT = 'Send a JSON object holding the command’s own fields.';
const READS: readonly string[] = [
  'The read half of the command surface has not been mounted in this deployment.',
];
const NO_BUSINESS: readonly string[] = [
  'Check that the business named in the path is the intended one.',
  'Ask an administrator of that business to link this login to a person.',
];

/** `isCommandRefusal` takes an object; a read executor's result is unknown until then. */
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** A body that is not an object is refused rather than coerced into one. */
async function readObject(
  context: Context,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const parsed: unknown = await context.req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}
