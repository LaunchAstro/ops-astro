// SPDX-License-Identifier: AGPL-3.0-only
//
// The HTTP boundary. Hono receives a command, derives the actor and the
// business from trusted authentication, and calls the domain operation that
// owns the rule (`docs/platform-construction.md`, Web API).
//
// It serves the read half of the surface as well as the commands, with the
// business taken from the path. Three things this file is careful not to be:
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

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  NO_MEMBERSHIP_FIXES,
  NO_AGENT_FIXES,
  EXPIRED_FIXES,
  recordBodyRefusal,
  statusOf,
} from '../../packages/core-records/src/index.ts';
import type { Database, VerifiedSubject } from '../../packages/core-records/src/index.ts';
import {
  agentAnswer,
  isCommandRefusal,
  isReadName,
  refuseCommand,
  refuseNotFound,
  setOwnAvailability,
  viewerOf,
} from '../../packages/core-commands/src/index.ts';
import {
  ACCOUNT_AVAILABILITY_PATH,
  COMMAND_SURFACE,
  DELEGATION_HEADER,
  PREFIX,
  pathOf,
} from '../../packages/core-wire/src/index.ts';
import { canonicalPayload } from '../../packages/core-digest/src/index.ts';
import type { CommandDeclaration } from '../../packages/core-wire/src/index.ts';
import type {
  executeCommand,
  executeAgentCommand,
  CommandRefusal,
  executeRead,
  admitReads,
  AdmissionAt,
} from '../../packages/core-commands/src/index.ts';
import type { Verifier } from './auth/supabase.ts';
import type { LiveTopics } from './live.ts';
import { markOf, presenceAskOf, type LivePresence, type SeatAsk } from './live-presence.ts';
import { follow, topicsOf, TOPICS, type Seated, type Watching } from './live-follow.ts';

/**
 * A read, run under the same tenancy wrapper and the same grant path:
 * `reads/execute.ts`'s signature, as `CommandExecutor` is the envelope's, so
 * the real executor is passed without a cast.
 *
 * The request names the read in `read` rather than in `command`, and
 * `packages/core-commands/src/reads/dispatch.ts` looks its catalogue row up by
 * that name. A read carries no `operation_id` and no `expected_revision`,
 * because there is nothing to replay and nothing to be stale against.
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
  readonly live?: LiveOptions;
}

/** The live task channel (T2f); absent, unmounted. `recheckMs`: how often a quiet stream re-asks. */
export interface LiveOptions {
  readonly topics: LiveTopics;
  readonly recheckMs?: number;
  /** `reads/execute.ts`'s `admitReads`: the channel's checks, which serve and audit nothing. */
  readonly admit: ReadAdmitter;
  /** C2: who else is on each watched task; absent, the stream carries no presence. */
  readonly presence?: LivePresence;
  /** `reads/execute.ts`'s `viewerOf`, unless a test hands in its own. */
  readonly viewer?: typeof viewerOf;
}

/** The live channel's check: `admitReads`'s signature. */
export type ReadAdmitter = typeof admitReads;

/** The person path's executor: `commands/envelope.ts`'s signature. */
export type CommandExecutor = typeof executeCommand;

/**
 * The agent path's executor: `commands/agent-envelope.ts`'s signature. The
 * credential travels beside the request, not inside it, which is why it is an
 * argument rather than a body field.
 */
export type AgentExecutor = typeof executeAgentCommand;

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
 * The door, the same on both prefixes.
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
  readsBody = true,
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
  const body = readsBody ? await readObject(context) : {};
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

  mountSurface(`${PREFIX.person}:businessKey`, PERSON, async (context, declaration, admitted) => {
    const { presented, businessId, body } = admitted;
    // The command comes from the route, never from the body, so a caller
    // cannot post to one endpoint and have another operation run. Nothing
    // here reads the body: each envelope parses it once against the route's
    // own row, and a body that does not match is refused there.
    const { name } = declaration;
    if (isReadName(name)) {
      // An absent or mistyped operand is refused by the read itself, inside
      // its audited transaction (`reads/dispatch.ts`), not here.
      // The name comes from the route here too, so a caller cannot post to
      // one read and have another one run.
      const read = await options.executeRead(options.database, businessId, presented, {
        ...body,
        read: name,
      });
      if (isCommandRefusal(read)) return refuse(context, read);
      return context.json(read, 200);
    }

    const result = await options.executeCommand(options.database, businessId, presented, 'api', {
      ...body,
      command: name,
    });

    if (isCommandRefusal(result)) return refuse(context, result);
    return context.json({ ...result }, 200);
  });

  // The second entry point. Same surface table, same paths, a different
  // prefix and a different envelope: `/api/a/b/alpha/task/pickup` is the agent
  // asking, `/api/b/alpha/task/pickup` is a person asking, and neither can be
  // mistaken for the other by a proxy, a log reader or the server.
  const agentExecutor = options.executeAgentCommand;
  if (agentExecutor !== undefined) {
    mountSurface(`${PREFIX.agent}:businessKey`, AGENT, async (context, declaration, admitted) => {
      const { presented, businessId, body } = admitted;
      // From the route, never from the body, exactly as on the person path: a
      // caller must not be able to post to one endpoint and have another
      // operation run. `operationId` is passed as the JSON carried it, absent
      // included: the envelope asks `typeof` itself and refuses anything that
      // is not a string, so the rule lives in one place.
      const result = await agentExecutor(
        options.database,
        businessId,
        presented,
        context.req.header(DELEGATION_HEADER),
        { ...body, command: declaration.name },
      );
      if (isCommandRefusal(result)) return refuse(context, result);
      return context.json(agentAnswer(declaration.name, result), 200);
    });
  }

  // T2f: a GET beside the POST-only surface, through the same door; no surface
  // row, so its own isolation case (`tests/api/t2f-live-channel.test.ts`).
  const { live } = options;
  if (live !== undefined) {
    api.get(`${PREFIX.person}:businessKey/live/task/:recordId`, async (context) => {
      const admitted = await admit(options, context, PERSON, false);
      if (admitted instanceof Response) return admitted;
      const asks = watching(options, live, context, admitted.businessId);
      const [taskId] = await asks.atDoor([context.req.param('recordId')]);
      if (taskId === undefined) throw new Error('the door answered no topic');
      if (typeof taskId !== 'string') return refuse(context, taskId);
      return streamSSE(context, async (stream) => {
        await follow(stream, live, [{ label: taskId, taskId }], asks);
      });
    });

    // C4: one stream per tab carries every topic its pages follow. Each topic
    // is asked about at join as T2f asks about its one task; one refused is
    // closed alone, all refused is the first refusal (`tests/api/c4-live-stream.test.ts`).
    api.get(`${PREFIX.person}:businessKey/live`, async (context) => {
      const admitted = await admit(options, context, PERSON, false);
      if (admitted instanceof Response) return admitted;
      const named = topicsOf(context.req.queries('topic') ?? []);
      if (named === undefined) {
        return refuse(context, refuseCommand('FIELD_VALUE_INVALID', ['topic'], [TOPICS]));
      }
      const asks = watching(options, live, context, admitted.businessId);
      const answers = await asks.atDoor(named.map((each) => each.taskId));
      const watched = named.filter((_, at) => typeof answers[at] === 'string');
      const [first] = answers;
      if (watched.length === 0 && first !== undefined && typeof first !== 'string') {
        return refuse(context, first);
      }
      return streamSSE(context, async (stream) => {
        for (const watch of named.filter((each) => !watched.includes(each))) {
          // eslint-disable-next-line no-await-in-loop -- written in the order named.
          await stream.writeSSE({ event: 'closed', data: watch.label });
        }
        await follow(stream, live, watched, asks, await seatOf(options, live, context, asks));
      });
    });

    // C2: presence on the stream's seat. Both routes check their input before
    // anything is read, resolve the caller as a recheck does and ask about the
    // task again, and write nothing (`tests/api/c2-presence-live.test.ts`).
    const { presence } = live;
    if (presence !== undefined) {
      api.post(`${PREFIX.person}:businessKey/live/mark`, async (context) => {
        const body = await readObject(context);
        const asked =
          body === undefined ? refuseCommand('COMMAND_BODY_INVALID', [], [OBJECT]) : markOf(body);
        return await onSeat(options, live, context, asked, (mark, viewer, businessId) =>
          presence.mark(businessId, mark.taskId, mark.seat, viewer, mark.field)
            ? { marked: true }
            : undefined,
        );
      });
      api.get(`${PREFIX.person}:businessKey/live/presence`, async (context) => {
        const asked = presenceAskOf(context.req.queries());
        return await onSeat(options, live, context, asked, (ask, viewer, businessId) => {
          const seenBy = presence.seenBy(businessId, ask.taskId, ask.seat, viewer);
          return seenBy === undefined ? undefined : { seenBy };
        });
      });
    }
  }

  // MP-7-10: the person's own availability, on the person prefix alone (their
  // own account; no agent holds it), audited with its row.
  api.post(`${PREFIX.person}:businessKey${ACCOUNT_AVAILABILITY_PATH}`, async (context) => {
    const admitted = await admit(options, context, PERSON);
    if (admitted instanceof Response) return admitted;
    const { database } = options;
    const result = await setOwnAvailability(
      database,
      admitted.businessId,
      admitted.presented,
      admitted.body,
    );
    return isCommandRefusal(result) ? refuse(context, result) : context.json(result, 200);
  });

  return api;
}

/**
 * A presence route once its input has passed: the door, the caller's standing
 * (nothing recorded), the task asked about again as the stream asks, then
 * `answer` for the caller's own person; undefined from it is no such seat.
 */
async function onSeat<A extends SeatAsk>(
  options: ApiOptions,
  live: LiveOptions,
  context: Context,
  asked: A | CommandRefusal,
  answer: (asked: A, personId: string, businessId: string) => object | undefined,
): Promise<Response> {
  const admitted = await admit(options, context, PERSON, false);
  if (admitted instanceof Response) return admitted;
  if (isCommandRefusal(asked)) return refuse(context, asked);
  const { businessId, presented } = admitted;
  const viewer = await (live.viewer ?? viewerOf)(options.database, businessId, presented);
  if (isCommandRefusal(viewer)) return refuse(context, viewer);
  const task = { read: 'task.execution' as const, recordId: asked.taskId };
  const again = await live.admit(options.database, businessId, presented, [task], 'recheck');
  const [admission] = isCommandRefusal(again) ? [again] : again;
  if (admission === undefined || isCommandRefusal(admission)) {
    return refuse(context, admission ?? refuseNotFound());
  }
  const answered = answer(asked, viewer.personId, businessId);
  return answered === undefined ? refuse(context, refuseNotFound()) : context.json(answered);
}

/** The stream's seat in the presence book, for a caller whose standing still resolves. */
async function seatOf(
  options: ApiOptions,
  live: LiveOptions,
  context: Context,
  asks: Watching,
): Promise<Seated | undefined> {
  const { presence } = live;
  const presented = await options.verify(context.req);
  if (presence === undefined || presented === undefined || presented === 'expired')
    return undefined;
  const viewer = await (live.viewer ?? viewerOf)(options.database, asks.businessId, presented);
  if (isCommandRefusal(viewer)) return undefined;
  const { personId, name, staff } = viewer;
  const session = { sessionId: randomUUID(), personId, name, side: staff ? 'staff' : 'client' };
  return { presence, session: session as Seated['session'] };
}

function watching(
  options: ApiOptions,
  live: LiveOptions,
  context: Context,
  businessId: string,
): Watching {
  const ask = async (taskIds: readonly string[], at: AdmissionAt) => {
    const answers = await mayWatch(options, live, context, businessId, taskIds, at);
    return isCommandRefusal(answers) ? taskIds.map(() => answers) : answers;
  };
  return {
    businessId,
    atDoor: async (taskIds) => await ask(taskIds, 'door'),
    async again(taskId) {
      const [answer] = await ask([taskId], 'recheck');
      if (answer === undefined) throw new Error('the recheck answered no topic');
      return answer;
    },
  };
}

/**
 * Whether this caller may watch each task, asked after verifying the bearer
 * again, of `task.execution`'s own admission, the internal activity the channel
 * reports: expiry, a lost membership, a revoked grant, a trashed or foreign
 * task and any external reader all refuse. It serves and audits nothing, since
 * the channel shows the person no content (C4 live-sync 6). Each answer is the
 * task's identifier, the topic, or its refusal.
 */
async function mayWatch(
  options: ApiOptions,
  live: LiveOptions,
  context: Context,
  businessId: string,
  taskIds: readonly string[],
  at: AdmissionAt,
): Promise<readonly (string | CommandRefusal)[] | CommandRefusal> {
  const presented = await options.verify(context.req);
  if (presented === undefined || presented === 'expired') {
    return refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES);
  }
  const requests = taskIds.map((recordId) => ({ read: 'task.execution' as const, recordId }));
  const admitted = await live.admit(options.database, businessId, presented, requests, at);
  if (isCommandRefusal(admitted)) return admitted;
  return admitted.map((answer) => {
    if (isCommandRefusal(answer)) return answer;
    if (answer.recordId === undefined) throw new Error('task.execution admitted no task');
    return answer.recordId;
  });
}

/**
 * One way out for every refusal, so the ones the boundary raises itself go
 * through the register's constructor and the status table like any other,
 * and none of them mints a code by hand.
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
const OBJECT = 'Send a JSON object holding the command’s own fields.';

/** The largest body a surface route reads. Files go by signed link, never through the API. */
export const MAX_BODY_BYTES = 1_048_576;

/**
 * A body that is not an object is refused rather than coerced into one, and
 * so is one over `MAX_BODY_BYTES`.
 *
 * So is one with no canonical form. `JSON.parse` reads a number too large for
 * a double, 1e400, as Infinity, and every entry takes the payload digest
 * before anything else, so that body would fault with nothing recorded.
 * Here it is a malformed body like any other.
 */
async function readObject(
  context: Context,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  try {
    const text = await readLimited(context.req.raw, MAX_BODY_BYTES);
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    canonicalPayload(parsed);
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return undefined;
  }
}

/**
 * The body as text, or nothing past `limit` bytes: counted as they arrive, so
 * a body with no Content-Length, or a wrong one, stops at the limit.
 */
async function readLimited(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get('content-length')) > limit) return undefined;
  let total = 0;
  const counted = request.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) controller.error(new RangeError('over the body limit'));
        else controller.enqueue(chunk);
      },
    }),
  );
  try {
    return await new Response(counted).text();
  } catch {
    return undefined;
  }
}
