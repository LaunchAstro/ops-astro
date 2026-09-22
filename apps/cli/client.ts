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
// **On "delegated actor" (#46), stated rather than implied.** A delegation is
// minted by `task.pickup`, and `task.pickup` is declared and not landed: the
// delegations and leases tables belong to no part of this split, which is why
// T1f routed it to `DEPENDENCY_NOT_LANDED`. So this client sends the credential
// it is handed; the *delegated* part of "delegated actor" is a seam here and
// not a mechanism. It proves the parity claim — an agent driving the product
// through this client reaches the same operations under the same authority as a
// person in the app — and it does not prove isolation case 9, which needs the
// table. `DECISIONS.tsv` carries this as a row rather than a footnote.

import {
  COMMAND_SURFACE,
  pathOf,
  type CommandName,
} from '../../packages/core-records/src/commands/surface.ts';

/** How a caller reaches the API. Injected so a test drives the real Hono app. */
export type Transport = (path: string, body: string, credential: string) => Promise<Response>;

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
}

export interface CliAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The verbs this client accepts, built from the declared surface.
 *
 * Built rather than written out: a hand-kept verb list is the drift the parity
 * test exists to catch, and it would put the drift in the place least likely
 * to be read. The parity test does not compare this against `COMMAND_SURFACE`
 * — that comparison could not fail — it compares what `accepts` really answers
 * against the operation surface read out of the dispatch.
 */
const VERBS: ReadonlySet<string> = new Set(COMMAND_SURFACE.map((command) => command.name));

/** Does the command line take this verb? The real answer, asked the real way. */
export function accepts(verb: string): boolean {
  return VERBS.has(verb);
}

export function createCli(options: CliOptions): {
  readonly run: (verb: string, payload: Readonly<Record<string, unknown>>) => Promise<CliAnswer>;
} {
  return {
    run: async (verb, payload) => {
      if (!accepts(verb)) {
        // The one answer this file gives on its own, and it is not an authority
        // check: it is "no such command", which the API would answer with a 404
        // and no operation would ever see. A caller can tell the two apart.
        return { status: 404, body: { code: 'COMMAND_UNKNOWN', names: [verb], fixes: [USAGE] } };
      }
      const response = await options.transport(
        `/api/b/${options.businessKey}${pathOf(verb as CommandName)}`,
        JSON.stringify(payload),
        options.credential,
      );
      return { status: response.status, body: await response.json() };
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
