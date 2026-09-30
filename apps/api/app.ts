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

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { deleteCookie, setCookie } from 'hono/cookie';
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
  boardHears,
  joinLiveBoard,
  shownInbox,
  refuseCommand,
} from '../../packages/core-commands/src/index.ts';
import {
  COMMAND_SURFACE,
  DELEGATION_HEADER,
  PREFIX,
  SESSION_PATH,
  pathOf,
} from '../../packages/core-wire/src/index.ts';
import { canonicalPayload } from '../../packages/core-digest/src/index.ts';
import type { CommandDeclaration } from '../../packages/core-wire/src/index.ts';
import type {
  executeCommand,
  executeAgentCommand,
  CommandRefusal,
  executeRead,
} from '../../packages/core-commands/src/index.ts';
import type { Verifier } from './auth/supabase.ts';
import type { LiveSignal, LiveTopics } from './live.ts';
import { followBoard } from './live-board.ts';
import { signalOf, type Outcome, type SecuritySignal } from './alerts/detect.ts';
import {
  bearerOf,
  cookieNameFor,
  CROSS_SITE_FIXES,
  crossSiteSession,
  fromOwnPages,
  MISMATCH_FIXES,
  namedSession,
  sessionIdOf,
  unnamedSession,
  SESSION_COOKIE_OPTIONS,
} from './auth/session.ts';

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
  /**
   * The security detections (ticket S0-2): each answer's outcome, as a signal
   * with no content. Absent in a deployment without an error sink.
   */
  readonly observe?: (signal: SecuritySignal) => void;
}

/** The live task channel (T2f); absent, unmounted. `recheckMs`: how often a quiet stream re-asks. */
export interface LiveOptions {
  readonly topics: LiveTopics;
  readonly recheckMs?: number;
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
  // A session cookie from another site's page stops here, before the
  // verifier reads it (`auth/session.ts`).
  if (crossSiteSession(context.req)) return refuse(context, CROSS_SITE());
  const presented = await options.verify(context.req);
  if (typeof presented === 'object') context.set(PRESENTED, presented);
  else clearNamedCookie(context);
  if (presented === undefined || presented === 'absent') {
    // A tab that names no sign-in of its own reads nothing on the cookies of
    // others: not them, their business or their clients.
    if (unnamedSession(context.req)) return refuse(context, MISMATCH());
    // No credential at all (a crawler, a probe) tried no sign-in: the same
    // answer, and never counted as a failed one (security line 9).
    if (presented === 'absent') context.set(NO_CREDENTIAL, true);
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

/**
 * The page ends its session on `AUTH_SESSION_EXPIRED` and `AUTH_UNKNOWN_LOGIN`
 * alike, and only the API can clear an `HttpOnly` cookie: a refused cookie
 * left behind rides beside every later sign-in's until the headers are too
 * large to answer. So the named sign-in's cookie goes with the refusal.
 */
function clearNamedCookie(context: Context): void {
  const session = namedSession(context.req);
  if (bearerOf(context.req) !== undefined || session === undefined) return;
  deleteCookie(context, cookieNameFor(session), SESSION_COOKIE_OPTIONS);
}

export function createApi(options: ApiOptions): Hono {
  const api = new Hono();

  // The browser trades the provider's token for the session cookie here, and
  // gives it back at `/end`; both only from this application's own pages.
  api.post(SESSION_PATH, async (context) => {
    if (!fromOwnPages(context.req)) return refuse(context, CROSS_SITE());
    const token = bearerOf(context.req);
    const presented = token === undefined ? undefined : await options.verify(context.req);
    if (presented === 'expired') {
      return refuse(context, refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES));
    }
    if (token === undefined || presented === undefined) {
      return refuse(context, refuseCommand('AUTH_UNKNOWN_LOGIN', [], [SIGN_IN]));
    }
    // No `Max-Age`: the cookie ends with the browser session and the token's
    // own `exp` ends it sooner. Its lifetime under the 12-hour limit is C58's.
    // Each sign-in its own cookie; the tab names it in `SESSION_HEADER`.
    const session = sessionIdOf(token);
    setCookie(context, cookieNameFor(session), token, SESSION_COOKIE_OPTIONS);
    return context.json({ ok: true, session }, 200);
  });
  api.post(`${SESSION_PATH}/end`, (context) => {
    if (!fromOwnPages(context.req)) return refuse(context, CROSS_SITE());
    // Only the named sign-in's cookie: a late answer cannot end any other.
    const session = namedSession(context.req);
    if (session !== undefined) {
      deleteCookie(context, cookieNameFor(session), SESSION_COOKIE_OPTIONS);
    }
    return context.json({ ok: true }, 200);
  });

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
        const response =
          admitted instanceof Response ? admitted : await run(context, declaration, admitted);
        const outcome = outcomeOf(context, declaration);
        const tried = (context as Context).get(NO_CREDENTIAL) !== true;
        const signal = options.observe && tried && signalOf(outcome);
        if (signal) options.observe?.(signal);
        // Download volume (security line 9): the records each read handed out, per business and reader.
        const { business, person: who, items } = outcome;
        if (items > 0) options.observe?.({ kind: 'export', business, who, items });
        return response;
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
      context.set(HANDED_OUT, recordsIn(read));
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
      // An agent's read hands out records too (security line 9, download volume): its queue, a task.
      if (declaration.kind === 'read') context.set(HANDED_OUT, recordsIn(result.detail ?? {}));
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
      const may = async () => await mayWatch(options, context, admitted.businessId);
      const taskId = await may();
      if (typeof taskId !== 'string') return refuse(context, taskId);
      return streamSSE(context, async (stream) => {
        await follow(stream, live, admitted.businessId, taskId, may);
      });
    });
    // INB-1f: the board's one stream per tab, through the same door. Each task
    // it names is asked as the task's own stream asks it; the inbox topic is
    // the caller's own person, which the join resolves, asked again each batch.
    api.get(`${PREFIX.person}:businessKey/live`, async (context) => {
      const admitted = await admit(options, context, PERSON, false);
      if (admitted instanceof Response) return admitted;
      const join = async () => await mayJoinBoard(options, context, admitted.businessId);
      const joined = await join();
      if (isCommandRefusal(joined)) return refuse(context, joined);
      return streamSSE(context, async (stream) => {
        await followBoard(
          stream,
          live.topics,
          {
            businessId: admitted.businessId,
            personId: joined.personId,
            recheckMs: live.recheckMs ?? RECHECK_MS,
          },
          {
            joinedAs: async () => {
              const again = await join();
              return isCommandRefusal(again) ? undefined : again.personId;
            },
            reads: async (taskId) => await mayHear(options, context, admitted.businessId, taskId),
            shown: async (personId) =>
              await mayShowInbox(options, context, admitted.businessId, personId),
          },
        );
      });
    });
  }

  return api;
}

/**
 * Whether this caller may watch the task, asked after verifying the bearer
 * again of `task.execution`, the internal activity the channel reports:
 * expiry, a revoked grant and any external reader all refuse.
 * The answer is the task's identifier, the topic.
 */
async function mayWatch(
  options: ApiOptions,
  context: Context,
  businessId: string,
): Promise<string | CommandRefusal> {
  const presented = await options.verify(context.req);
  if (typeof presented !== 'object') {
    return refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES);
  }
  const read = await options.executeRead(options.database, businessId, presented, {
    read: 'task.execution',
    recordId: context.req.param('recordId'),
  });
  if (isCommandRefusal(read)) return read;
  if ('execution' in read) return read.execution.taskId;
  throw new Error('task.execution answered something other than an execution');
}

/** Whether this caller may hold the board's stream (INB-1f), with the bearer verified again. */
async function mayJoinBoard(
  options: ApiOptions,
  context: Context,
  businessId: string,
): Promise<{ readonly personId: string } | CommandRefusal> {
  const presented = await options.verify(context.req);
  if (typeof presented !== 'object') {
    return refuseCommand('AUTH_SESSION_EXPIRED', [], EXPIRED_FIXES);
  }
  return await joinLiveBoard(options.database, businessId, presented);
}

/** Whether the board's reader may hear this task move, with the bearer verified again. */
async function mayHear(
  options: ApiOptions,
  context: Context,
  businessId: string,
  taskId: string,
): Promise<boolean> {
  const presented = await options.verify(context.req);
  if (typeof presented !== 'object') return false;
  return await boardHears(options.database, businessId, presented, taskId);
}

/** What `inbox.read` shows the stream's own person now, asked with the bearer verified again. */
async function mayShowInbox(
  options: ApiOptions,
  context: Context,
  businessId: string,
  personId: string,
): Promise<string | undefined> {
  const presented = await options.verify(context.req);
  if (typeof presented !== 'object') return undefined;
  return await shownInbox(options.database, businessId, presented, personId);
}

const RECHECK_MS = 30_000;
const noop = (): void => {};
const RANK = { check: 0, invalidate: 1, resync: 2 } as const;

/**
 * One open stream: `resync` once subscribed, then each signal once the caller
 * is asked again, and `closed` the first time the answer is no. Signals that
 * arrive while one is pending merge into it, the strongest kept. Stopping it
 * (the tab leaving, or the topics closing) lets go only once no question it
 * asked is in flight.
 */
export async function follow(
  stream: SSEStreamingApi,
  live: LiveOptions,
  businessId: string,
  taskId: string,
  may: () => Promise<string | CommandRefusal>,
): Promise<void> {
  const ended = new Promise<void>((resolve) => {
    stream.onAbort(resolve);
  });
  let pending: LiveSignal | 'check' | null = null;
  let chain = Promise.resolve();
  const send = async (): Promise<void> => {
    const signal = pending;
    pending = null;
    if (signal === null || stream.aborted) return;
    if (typeof (await may()) !== 'string') {
      await stream.writeSSE({ event: 'closed', data: taskId });
      stream.abort();
    } else if (signal !== 'check') await stream.writeSSE({ event: signal, data: taskId });
  };
  const want = (signal: LiveSignal | 'check'): void => {
    if (pending === null) chain = chain.then(send).catch(() => stream.abort());
    if (pending === null || RANK[signal] > RANK[pending]) pending = signal;
  };
  let finished = noop;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const stop = async (): Promise<void> => {
    stream.abort();
    await done;
  };
  const unsubscribe = live.topics.subscribe(businessId, taskId, want, stop);
  const timer = setInterval(() => want('check'), live.recheckMs ?? RECHECK_MS);
  try {
    await stream.writeSSE({ event: 'resync', data: taskId });
    await ended;
  } finally {
    clearInterval(timer);
    await chain;
    unsubscribe();
    finished();
  }
}

/**
 * One way out for every refusal, so the ones the boundary raises itself go
 * through the register's constructor and the status table like any other,
 * and none of them mints a code by hand.
 */
function refuse(context: Context, refusal: CommandRefusal): Response {
  context.set(REFUSAL, refusal.code);
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

const PRESENTED = 'presented';
const REFUSAL = 'refusal';
const HANDED_OUT = 'handed-out';
const NO_CREDENTIAL = 'no-credential';

/** How many records a read handed out: a task is one, a list is its length. */
function recordsIn(read: object): number {
  const lists = ['tasks', 'persons', 'queue'].map((key) => (read as Record<string, unknown>)[key]);
  const listed = lists.find((list): list is readonly unknown[] => Array.isArray(list));
  if (listed !== undefined) return listed.length;
  return 'task' in read || 'sharedTask' in read ? 1 : 0;
}
/** The answer's outcome, as the detector reads it: no content, only scopes and a code. */
function outcomeOf(context: Context, declaration: CommandDeclaration): Outcome {
  const presented = context.get(PRESENTED) as VerifiedSubject | undefined;
  return {
    business: context.req.param('businessKey') ?? '',
    person: presented === undefined ? '' : `${presented.provider}\u0000${presented.subject}`,
    refusal: context.get(REFUSAL) as string | undefined,
    items: (context.get(HANDED_OUT) as number | undefined) ?? 0,
    command: declaration.name,
  };
}

const SIGN_IN = 'Sign in. This endpoint reads the caller from verified authentication only.';
const CROSS_SITE = (): CommandRefusal => refuseCommand('AUTH_CROSS_SITE', [], CROSS_SITE_FIXES);
const MISMATCH = (): CommandRefusal => refuseCommand('AUTH_SESSION_MISMATCH', [], MISMATCH_FIXES);
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
