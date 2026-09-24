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
import {
  NO_MEMBERSHIP_FIXES,
  type VerifiedSubject,
} from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  NO_AGENT_FIXES,
  refuseExpiredSession,
} from '../../packages/core-records/src/identity/agent-login.ts';
import type { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import {
  agentAnswer,
  type AgentRequest,
  type executeAgentCommand,
} from '../../packages/core-records/src/commands/agent-envelope.ts';
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
import type { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import type { ReadRequest } from '../../packages/core-records/src/reads/requests.ts';
import { recordBodyRefusal } from '../../packages/core-records/src/identity/authentication-attempts.ts';
import type { Verifier } from './auth/supabase.ts';
import { statusOf } from '../../packages/core-records/src/commands/register.ts';

/**
 * A read, run under the same tenancy wrapper and the same grant path:
 * `reads/execute.ts`'s signature, as `CommandExecutor` is the envelope's, so
 * the real executor is passed without a cast.
 *
 * The request names the read in `read` rather than in `command`, which is the
 * discriminant `packages/core-records/src/reads/requests.ts` switches on. A
 * read carries no `operation_id` and no `expected_revision`, because there is
 * nothing to replay and nothing to be stale against.
 */
export type ReadExecutor = typeof executeRead;

export interface ApiOptions {
  readonly database: Database;
  /**
   * Trusted authentication. It reads the request and returns the subject a
   * provider has verified, or nothing. It is the only way a caller's identity
   * enters the system, and it is passed in rather than chosen here so a
   * deployment cannot be talked into a second one.
   */
  readonly verify: Verifier;
  /**
   * The business key from the path to the server's own identifier, or nothing
   * if there is no such business. Injected for the same reason `verify` is:
   * the boundary must not be able to read the tenancy root itself.
   */
  readonly resolveBusiness: (businessKey: string) => Promise<string | undefined>;
  /**
   * The read half of the surface, `reads/execute.ts` in every deployment.
   * Required for the same reason `executeCommand` is: every declaration the
   * surface marks `kind: 'read'` is mounted, and each needs an executor.
   */
  readonly executeRead: ReadExecutor;
  /**
   * The person path's command envelope, `commands/envelope.ts` in every
   * deployment. Required, and never imported here, so the composition root
   * names every executor the boundary calls and there is no default a caller
   * can get without saying so.
   */
  readonly executeCommand: CommandExecutor;
  /**
   * The agent's own entry point.
   *
   * Injected like `verify` and `executeRead` rather than imported here,
   * because mounting it is a composition-root decision: a deployment that
   * serves no agents should not have the routes at all, and a boundary that
   * reached for the module itself would make that undecidable. Absent means
   * the agent prefix is not mounted and an agent's request finds no route,
   * which is the honest answer for a deployment that has not enabled it.
   */
  readonly executeAgentCommand?: AgentExecutor;
}

/** The person path's executor: `commands/envelope.ts`'s signature. */
export type CommandExecutor = typeof executeCommand;

/**
 * The agent path's executor: `commands/agent-envelope.ts`'s signature. The
 * credential travels beside the request, not inside it, which is why it is an
 * argument rather than a body field.
 */
export type AgentExecutor = typeof executeAgentCommand;

/**
 * The header an agent presents its delegation credential in.
 *
 * A header rather than a body field for the same reason the bearer token is
 * one: it is a credential, and a credential in a body is a credential that
 * gets logged with the payload, stored in the register row and compared by a
 * digest. The register compares what the request *is*; the authority it was
 * made under is not part of that.
 */
export const DELEGATION_HEADER = 'x-agent-delegation';

/**
 * What one prefix does differently at the door: whose login table it records
 * a body refusal against, and what a key that resolves to no business answers.
 */
interface Entry {
  readonly owner: 'person_login' | 'agent_login';
  readonly unresolved: () => CommandRefusal;
}

// A key that names no business answers with the fixes the prefix's own login
// resolution gives a caller the business does not know, imported rather than
// copied, so the two cannot be told apart or drift apart.
// `tests/api/admission-enumeration.test.ts` compares the bytes.
const PERSON: Entry = {
  owner: 'person_login',
  unresolved: () => refuseCommand('AUTH_NO_MEMBERSHIP', [], NO_MEMBERSHIP_FIXES),
};
const AGENT: Entry = {
  owner: 'agent_login',
  unresolved: () => refuseCommand('AUTH_NO_AGENT_IDENTITY', [], NO_AGENT_FIXES),
};

interface Admitted {
  readonly presented: VerifiedSubject;
  readonly businessId: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The door, the same on both prefixes (Sol 6 SURFACE-1, AUTHORITY-1).
 *
 * An expired bearer is the re-login answer before the key or the body is
 * looked at. A malformed body is refused the same way whether the key names a
 * business or not, and the attempt is recorded only in a business that
 * resolved. A key that names no business answers exactly as the prefix's own
 * login resolution answers a caller the business does not know, so a key that
 * exists and one that does not cannot be told apart.
 */
async function admit(
  options: ApiOptions,
  context: Context,
  entry: Entry,
): Promise<Admitted | Response> {
  const presented = await options.verify(context.req);
  if (presented === undefined) {
    return refuse(context, refuseCommand('AUTH_UNKNOWN_LOGIN', [], [SIGN_IN]));
  }
  // An expired bearer is its own answer on both paths. It is the re-login
  // door, and a client shown `AUTH_UNKNOWN_LOGIN` for it cannot tell a
  // session that ended from a credential that was never good.
  if (presented === 'expired') {
    return refuse(context, refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES));
  }

  // The key comes from the path and is resolved by the server.
  const body = await readObject(context);
  const businessId = await options.resolveBusiness(context.req.param('businessKey') ?? '');
  if (body === undefined) {
    // An admission refusal: the resolved business, the verified subject (ruling 4).
    if (businessId !== undefined) {
      await recordBodyRefusal(options.database, businessId, entry.owner, presented);
    }
    return refuse(context, refuseCommand('COMMAND_BODY_INVALID', [], [OBJECT]));
  }
  if (businessId === undefined) return refuse(context, entry.unresolved());
  return { presented, businessId, body };
}

export function createApi(options: ApiOptions): Hono {
  const api = new Hono();

  /** One route per surface declaration under `prefix`, each through the door. */
  function mountSurface(
    prefix: string,
    entry: Entry,
    run: (
      context: Context,
      declaration: CommandDeclaration,
      admitted: Admitted,
    ) => Promise<Response>,
  ): void {
    const routes = new Hono();
    for (const declaration of COMMAND_SURFACE) {
      routes.post(pathOf(declaration.name), async (context) => {
        const admitted = await admit(options, context, entry);
        if (admitted instanceof Response) return admitted;
        return await run(context, declaration, admitted);
      });
    }
    api.route(prefix, routes);
  }

  mountSurface('/api/b/:businessKey', PERSON, async (context, declaration, admitted) => {
    const { presented, businessId, body } = admitted;
    // The command comes from the route, never from the body, so a caller
    // cannot post to one endpoint and have another operation run.
    if (declaration.kind === 'read') {
      // An absent or mistyped operand is refused by the read itself, inside
      // its audited transaction (`reads/dispatch.ts`), not here.
      // The name comes from the route here too, so a caller cannot post to
      // one read and have another one run.
      const read = await options.executeRead(options.database, businessId, presented, {
        ...body,
        read: declaration.name,
      } as ReadRequest);
      if (isCommandRefusal(read)) return refuse(context, read);
      return context.json(read, 200);
    }

    const request = { ...body, command: declaration.name } as CommandRequest;
    const result = await options.executeCommand(
      options.database,
      businessId,
      presented,
      'api',
      request,
    );

    if (isCommandRefusal(result)) return refuse(context, result);
    return context.json({ ...result }, 200);
  });

  // The second entry point. Same surface table, same paths, a different
  // prefix and a different envelope: `/api/a/b/alpha/task/pickup` is the agent
  // asking, `/api/b/alpha/task/pickup` is a person asking, and neither can be
  // mistaken for the other by a proxy, a log reader or the server.
  const agentExecutor = options.executeAgentCommand;
  if (agentExecutor !== undefined) {
    mountSurface('/api/a/b/:businessKey', AGENT, async (context, declaration, admitted) => {
      const { presented, businessId, body } = admitted;
      // From the route, never from the body, exactly as on the person path: a
      // caller must not be able to post to one endpoint and have another
      // operation run. `operationId` is passed as the JSON carried it, absent
      // included: the envelope asks `typeof` itself and refuses anything that
      // is not a string, so the rule lives in one place (Sol 6 AUTHORITY-4).
      const request = { ...body, command: declaration.name } as AgentRequest;
      const result = await agentExecutor(
        options.database,
        businessId,
        presented,
        context.req.header(DELEGATION_HEADER),
        request,
      );
      if (isCommandRefusal(result)) return refuse(context, result);
      return context.json(agentAnswer(declaration.name, result) as Record<string, unknown>, 200);
    });
  }

  return api;
}

/**
 * One way out for every refusal, so the ones the boundary raises itself go
 * through the register's constructor and the status table like any other. A
 * review of the draft found both of its own minting a code by hand.
 */
function refuse(context: Context, refusal: CommandRefusal): Response {
  // `refused: true` is the flag that makes this a refusal on the wire and not
  // merely a status code. A caller reading the status alone cannot tell a
  // decision the server made from a server that fell over, and the mounted
  // app's client says so in as many words: a non-2xx with no refusal body is
  // drawn as *unavailable*, because calling it denied would invent an
  // authority decision nobody made. Without the flag every refusal this
  // boundary returns arrived there as an outage.
  return context.json(
    { refused: true, code: refusal.code, names: refusal.names, fixes: refusal.fixes },
    statusOf(refusal.code),
  );
}

const SIGN_IN = 'Sign in. This endpoint reads the caller from verified authentication only.';
// The canonical expired refusal's fixes, read from the agent envelope's own
// constructor rather than copied, so the door and `refuseExpiredSession`
// cannot drift apart. `tests/api/admission-enumeration.test.ts` pins the bytes.
const EXPIRED_FIXES = refuseExpiredSession().fixes;
const OBJECT = 'Send a JSON object holding the command’s own fields.';

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
