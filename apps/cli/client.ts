// SPDX-License-Identifier: AGPL-3.0-only
//
// The ordinary command line: a client of the same authenticated interface the
// application uses, holding no privileged path (specification 17).
//
// It is not a second implementation of the operations — it posts to the API and
// returns what comes back, which is the half of `no_transport_only_authority`
// this file owns: there is no check to remove from it, because there is none in
// it. It is not a shorter list than the API's: every domain operation is here,
// `task.decide` included, because what a delegated agent lacks is the authority
// and not the command (17.1), and the refusal comes from the grant check inside
// the serving transaction. And it is not the operator tool, which is a separate
// binary because install, backup, restore and recovery are host control (17.3).
//
// **On "delegated actor" (#46).** A delegation is minted by `task.pickup` and
// travels as its own credential in the `x-agent-delegation` header, beside the
// agent's own login bearer, on the agent prefix `/api/a/b/:businessKey`
// (`apps/api/app.ts`). This client carries both as it was handed them: it
// chooses the prefix the caller asked for and sends the headers, and the
// server decides whether the login is an agent's, whether the delegation is
// live and whether it reaches the operation. Nothing here mints, signs or
// inspects either credential.
//
// `main.ts` beside this file is the runnable entry (`pnpm cli`); this module
// stays importable so a test can drive it with an injected transport.

import {
  COMMAND_SURFACE,
  pathOf,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';

/**
 * How a caller reaches the API. Injected so a test drives the real Hono app.
 *
 * `delegation` is the agent's delegation credential, sent as its own header
 * when present. The person path never passes one.
 */
export type Transport = (
  path: string,
  body: string,
  credential: string,
  delegation?: string,
) => Promise<Response>;

export interface CliOptions {
  readonly transport: Transport;
  /**
   * Which business the caller is acting in, as the path prefix spells it.
   *
   * It is the same named-and-verified business the browser client sends: the
   * key says what the caller means and the server decides whether they are a
   * member of it. A command line that could pick a business the server did not
   * check would be exactly the privileged path specification 17 says this tool
   * does not have.
   */
  readonly businessKey: string;
  /**
   * What the client presents. An agent presents its own agent login, never the
   * person's (specification 17.2); this client does not know which it holds and
   * must not, because a client that can tell is a client that can choose.
   */
  readonly credential: string;
  /**
   * Which entry point to call. `person` (the default) posts to
   * `/api/b/:businessKey`; `agent` posts to `/api/a/b/:businessKey`, where the
   * server checks that the login is an agent's. Choosing the prefix is not
   * choosing an actor: a person's login on the agent prefix is refused there.
   */
  readonly entry?: 'person' | 'agent';
  /** The delegation credential a pickup returned, sent on the agent prefix only. */
  readonly delegation?: string;
}

/**
 * The two prefixes, as the API mounts them (`apps/api/app.ts`), and the header
 * the delegation travels in (`DELEGATION_HEADER` there). One copy on this side,
 * which `main.ts` imports; `tests/cli/cli-wire.test.ts` pins both against what
 * the API is sent, the header by the API's own constant.
 */
const PREFIX = { person: '/api/b/', agent: '/api/a/b/' } as const;
export const DELEGATION_HEADER = 'x-agent-delegation';

export interface CliAnswer {
  readonly status: number;
  /** The parsed JSON body, or `undefined` when the body was not JSON. */
  readonly body: unknown;
  /** The body as it came, for an answer that was not JSON. */
  readonly text?: string;
}

/**
 * The verbs this client accepts, built from the declared surface.
 *
 * Built rather than written out: a hand-kept verb list is drift, and it would
 * put the drift in the place least likely to be read.
 * `tests/acceptance/surface-inventory.test.ts` asks this client, not
 * `COMMAND_SURFACE`, whether each declaration is reachable.
 */
const VERBS: ReadonlySet<string> = new Set(COMMAND_SURFACE.map((command) => command.name));

/** Does the command line take this verb? The real answer, asked the real way. */
export function accepts(verb: string): boolean {
  return VERBS.has(verb);
}

/**
 * Is this verb a write? The registry's `kind` says, and only a write carries an
 * operation identity: a read has nothing to replay.
 */
export function isWrite(verb: string): boolean {
  return COMMAND_SURFACE.some((command) => command.name === verb && command.kind === 'write');
}

/**
 * Did the API refuse? A refusal is a body flagged `refused: true` with a code,
 * as `apps/api/app.ts` writes it and the web client reads it. A non-2xx without
 * the flag is the server failing, not an authority decision.
 */
export function isRefusal(answer: CliAnswer): boolean {
  const body = answer.body as { refused?: unknown; code?: unknown } | null | undefined;
  return body?.refused === true && typeof body.code === 'string';
}

/**
 * The one answer this file gives on its own, and it is not an authority check:
 * it is "no such command", which the API would answer with a 404 and no
 * operation would ever see. A caller can tell the two apart.
 */
export function unknownVerb(verb: string): CliAnswer {
  const body = { code: 'COMMAND_UNKNOWN', names: [verb], fixes: [USAGE] };
  return { status: 404, body, text: JSON.stringify(body) };
}

export function createCli(options: CliOptions): {
  readonly run: (verb: string, payload: Readonly<Record<string, unknown>>) => Promise<CliAnswer>;
} {
  return {
    run: async (verb, payload) => {
      if (!accepts(verb)) return unknownVerb(verb);
      const entry = options.entry ?? 'person';
      const path = `${PREFIX[entry]}${options.businessKey}${pathOf(verb as CommandName)}`;
      const body = JSON.stringify(payload);
      const response =
        entry === 'agent' && options.delegation !== undefined && options.delegation !== ''
          ? await options.transport(path, body, options.credential, options.delegation)
          : await options.transport(path, body, options.credential);
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { status: response.status, body: parsed, text };
    },
  };
}

const USAGE = 'Run with no arguments to list the operations this command line offers.';

/** What `--help` prints. The same set, in the same order, from the same table. */
export function usage(): readonly string[] {
  return COMMAND_SURFACE.map(
    (command) => `${command.name}${command.landed ? '' : `  (waiting on ${command.waitingOn})`}`,
  );
}
