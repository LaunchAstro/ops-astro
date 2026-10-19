// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the source control provider a correction's proposal reaches:
// branches, commits of the one site file, and requests, for any repository.
// It answers the three guarded writes `proposeSource` sends behind the
// transport, and the seam's reads as the proposal step's ports. One step can be
// cut: its answer is lost as a timeout, after it landed or before. A hook sees
// each write as it leaves. Nothing leaves the process.

import type { ProposePorts } from '../../packages/core-commands/src/index.ts';
import type {
  TransportAnswer,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';

export type Step = 'branch' | 'commit' | 'request';

interface Commit {
  readonly parent: string;
  readonly blob: string;
  readonly content: string;
}

export interface StandIn {
  readonly commits: Map<string, Commit>;
  readonly branches: Map<string, string>;
  readonly requests: { readonly number: number; readonly branch: string }[];
  /** Every write sent, by step, in order. */
  readonly sent: Step[];
  readonly raised: string[];
  readonly ports: ProposePorts;
}

/** Set for one run and cleared for the next, as a restart finds the provider. */
export interface Knobs {
  /** The step whose answer is lost, and whether it landed first. */
  cut?: { readonly step: Step; readonly landed: boolean } | undefined;
  /** The step whose sending throws, as a worker lost mid-proposal; it lands first. */
  crash?: Step | undefined;
  /** Runs as each write leaves, before it lands. */
  onSend?: ((step: Step) => Promise<void>) | undefined;
}

const json = (body: unknown, status: number): TransportAnswer => ({
  kind: 'answer',
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

const STEPS: readonly (readonly [Step, string, RegExp])[] = [
  ['branch', 'POST', /^\/repos\/[^/]+\/[^/]+\/git\/refs$/u],
  ['commit', 'PUT', /^\/repos\/[^/]+\/[^/]+\/contents\/.+$/u],
  ['request', 'POST', /^\/repos\/[^/]+\/[^/]+\/pulls$/u],
];

type Body = Readonly<Record<string, string>>;
type Held = Pick<StandIn, 'commits' | 'branches' | 'requests'>;

/** A branch made at the commit named, unless it exists. */
function makeBranch(held: Held, body: Body): TransportAnswer {
  const name = (body['ref'] ?? '').replace(/^refs\/heads\//u, '');
  if (held.branches.has(name)) return json({ message: 'Reference already exists' }, 422);
  held.branches.set(name, body['sha'] ?? '');
  return json({ ref: body['ref'], object: { sha: body['sha'] } }, 201);
}

/** The file written on a branch over the blob named, as one new commit. */
function commit(held: Held, body: Body): TransportAnswer {
  const branch = body['branch'] ?? '';
  const head = held.branches.get(branch);
  const at = head === undefined ? undefined : held.commits.get(head);
  if (head === undefined || at === undefined) return json({ message: 'Not Found' }, 404);
  if (at.blob !== body['sha']) return json({ message: 'sha does not match' }, 409);
  const n = held.commits.size;
  const content = Buffer.from(body['content'] ?? '', 'base64').toString('utf8');
  held.commits.set(`commit-${n}`, { parent: head, blob: `blob-${n}`, content });
  held.branches.set(branch, `commit-${n}`);
  return json(
    { content: { sha: `blob-${n}` }, commit: { sha: `commit-${n}`, parents: [{ sha: head }] } },
    200,
  );
}

function openRequest(held: Held, body: Body): TransportAnswer {
  const number = 17 + held.requests.length;
  held.requests.push({ number, branch: body['head'] ?? '' });
  return json({ number }, 201);
}

const LAND: Readonly<Record<Step, (held: Held, body: Body) => TransportAnswer>> = {
  branch: makeBranch,
  commit,
  request: openRequest,
};

/** The three writes behind the transport, each cut, crashed or seen as `knobs` say. */
function transportOf(held: Held, sent: Step[], knobs: Knobs) {
  return async (request: TransportRequest): Promise<TransportAnswer> => {
    const found = STEPS.find(
      ([, method, path]) => method === request.method && path.test(request.url.pathname),
    );
    if (found === undefined) return json({ message: 'Not Found' }, 404);
    const [step] = found;
    const body =
      request.body === undefined
        ? {}
        : (JSON.parse(new TextDecoder().decode(request.body)) as Record<string, string>);
    sent.push(step);
    await knobs.onSend?.(step);
    if (knobs.crash === step) {
      LAND[step](held, body);
      throw new Error('worker lost mid-proposal');
    }
    if (knobs.cut?.step === step) {
      if (knobs.cut.landed) LAND[step](held, body);
      return { kind: 'timeout' };
    }
    return LAND[step](held, body);
  };
}

const ok = <T>(value: T) => Promise.resolve({ kind: 'ok', value } as const);

/** The seam's reads, as the provider holds it now. */
function seamReads(held: Held): Pick<ProposePorts, 'branch' | 'file' | 'request'> {
  return {
    branch: (seam) => {
      const head = held.branches.get(seam);
      if (head === undefined) return ok(null);
      return ok({ head, parent: held.commits.get(head)?.parent ?? '' });
    },
    file: (ref) => {
      const at = held.commits.get(ref);
      if (at === undefined) return Promise.resolve({ kind: 'refused', code: 'PROVIDER_REFUSED' });
      return ok({ blob: at.blob, content: at.content });
    },
    request: (seam) => {
      const open = held.requests.find((request) => request.branch === seam);
      const head = held.branches.get(seam);
      if (open === undefined || head === undefined) return ok(null);
      return ok({ number: String(open.number), head });
    },
  };
}

/** The provider holding the base revision's file, with no branch but the default one. */
export function standIn(
  base: { revision: string; blob: string; content: string },
  knobs: Knobs = {},
): StandIn {
  const held: Held = {
    commits: new Map([[base.revision, { parent: 'root', blob: base.blob, content: base.content }]]),
    branches: new Map([['main', base.revision]]),
    requests: [],
  };
  const sent: Step[] = [];
  const raised: string[] = [];
  const recorded: string[] = [];
  const ports: ProposePorts = {
    connector: {
      transport: transportOf(held, sent, knobs),
      resolve: () => Promise.resolve(['140.82.112.6']),
      credential: (entry) => Promise.resolve(`token-${entry}`),
      record: (code) => {
        recorded.push(code);
      },
    },
    ...seamReads(held),
    // The default branch's head now: the base revision until something moves it.
    head: () => ok(held.branches.get('main') ?? ''),
    raiseTask: (reason) => {
      raised.push(reason);
      return Promise.resolve();
    },
  };
  return { ...held, sent, raised, ports };
}
