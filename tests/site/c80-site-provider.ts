// SPDX-License-Identifier: AGPL-3.0-only
//
// A double of the source control and hosting providers behind the guarded
// call's transport: one repository, one site file, one proposal, one hosting
// project. It answers each catalogued request as the provider would and keeps
// every request it was sent, so a test reads what left and in what order.
// Nothing leaves the process.

import {
  contentDigest,
  versionDigestOf,
  type BindingDependencies,
  type ProposeInput,
  type SiteBinding,
  type TransportAnswer,
  type TransportRequest,
  type VersionPin,
} from '../../packages/core-connectors/src/index.ts';

export const REPOSITORY = 'agency/site';
export const PROJECT = 'prj_site';
export const HEAD = 'c0ffee01';
export const MERGED = 'c0ffee02';
export const REVERTED = 'c0ffee03';

export interface SentRequest {
  readonly method: string;
  readonly host: string;
  /** Path and query, as sent. */
  readonly target: string;
  readonly authorization: string | undefined;
  readonly body: Readonly<Record<string, string>>;
}

export interface ProviderState {
  /** The site file on the default branch. */
  content: string;
  blob: string;
  branches: string[];
  proposed: string | undefined;
  request: { number: number; head: string; merged: boolean } | undefined;
  /** Merged commits the hosting project has a production deployment for. */
  deployments: Record<string, string>;
  /** Lookups that find nothing yet, as while a deployment is being created. */
  lookupMisses: number;
  /** A hostile lookup: the deployment it answers is for another commit. */
  lookupCommit: string | undefined;
  /** Requests answered by a fixed answer instead, by method and path prefix. */
  answers: Record<string, TransportAnswer>;
}

const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const decode = (text: string): string => Buffer.from(text, 'base64').toString('utf8');

export const json = (body: unknown, status = 200): TransportAnswer => ({
  kind: 'answer',
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: new TextEncoder().encode(JSON.stringify(body)),
});

type Route = (state: ProviderState, body: Readonly<Record<string, string>>) => TransportAnswer;

const CONTENTS = `/repos/${REPOSITORY}/contents/src/pages/about.md`;

function writeContents(state: ProviderState, body: Readonly<Record<string, string>>) {
  if (body['sha'] !== state.blob) return json({ message: 'sha does not match' }, 409);
  const content = decode(body['content'] ?? '');
  if (body['branch'] !== 'main') {
    state.proposed = content;
    return json({ content: { sha: 'blob-head' }, commit: { sha: HEAD } }, 200);
  }
  state.content = content;
  state.blob = 'blob-reverted';
  state.deployments[REVERTED] = 'dpl_reverted';
  return json({ content: { sha: state.blob }, commit: { sha: REVERTED } }, 200);
}

function merge(state: ProviderState, body: Readonly<Record<string, string>>) {
  const request = state.request;
  if (request === undefined) return json({ message: 'Not Found' }, 404);
  if (request.merged) return json({ message: 'Pull Request is not mergeable' }, 405);
  if (body['sha'] !== request.head) return json({ message: 'Head branch was modified' }, 409);
  request.merged = true;
  state.content = state.proposed ?? state.content;
  state.deployments[MERGED] = 'dpl_merged';
  return json({ merged: true, sha: MERGED, message: 'merged', token: 'never-crosses' });
}

function lookup(state: ProviderState, query: URLSearchParams) {
  const sha = query.get('sha') ?? '';
  if (state.lookupMisses > 0) {
    state.lookupMisses -= 1;
    return json({ deployments: [], pagination: {} });
  }
  const uid = state.deployments[sha];
  if (uid === undefined) return json({ deployments: [], pagination: {} });
  const commit = state.lookupCommit ?? sha;
  return json({ deployments: [{ uid, meta: { githubCommitSha: commit } }], pagination: {} });
}

const ROUTES: Readonly<Record<string, Route>> = {
  [`GET api.github.com ${CONTENTS}`]: (state) =>
    json({ sha: state.blob, content: encode(state.content), encoding: 'base64', size: 1 }),
  [`PUT api.github.com ${CONTENTS}`]: writeContents,
  [`POST api.github.com /repos/${REPOSITORY}/git/refs`]: (state, body) => {
    const name = (body['ref'] ?? '').replace(/^refs\/heads\//u, '');
    if (state.branches.includes(name)) return json({ message: 'Reference already exists' }, 422);
    state.branches.push(name);
    return json({ ref: body['ref'], object: { sha: body['sha'] } }, 201);
  },
  [`POST api.github.com /repos/${REPOSITORY}/pulls`]: (state, body) => {
    state.request = { number: 17, head: HEAD, merged: false };
    return json({ number: 17, head: { sha: HEAD, ref: body['head'] } }, 201);
  },
  [`PUT api.github.com /repos/${REPOSITORY}/pulls/17/merge`]: merge,
  [`GET api.github.com /repos/${REPOSITORY}/pulls/17`]: (state) =>
    json({
      merged: state.request?.merged ?? false,
      state: state.request?.merged ? 'closed' : 'open',
    }),
};

export interface Provider {
  readonly state: ProviderState;
  readonly sent: SentRequest[];
  readonly waits: number[];
  readonly recorded: string[];
  readonly deps: BindingDependencies;
}

function route(
  state: ProviderState,
  request: TransportRequest,
  sent: SentRequest,
): TransportAnswer {
  const key = `${sent.method} ${sent.host} ${request.url.pathname}`;
  const fixed = Object.entries(state.answers).find(([prefix]) => key.startsWith(prefix));
  if (fixed !== undefined) return fixed[1];
  if (key === `GET api.vercel.com /v6/deployments`) return lookup(state, request.url.searchParams);
  const served = /^GET api\.vercel\.com \/v13\/deployments\/(.+)$/u.exec(key);
  if (served !== null) {
    const sha = Object.keys(state.deployments).find(
      (commit) => state.deployments[commit] === served[1],
    );
    return json({
      id: served[1],
      readyState: 'READY',
      target: 'production',
      meta: { githubCommitSha: sha ?? '' },
    });
  }
  return ROUTES[key]?.(state, sent.body) ?? json({ message: 'Not Found' }, 404);
}

/** The providers, starting from the site file and the proposal state given. */
export function provider(start: Partial<ProviderState> & Pick<ProviderState, 'content'>): Provider {
  const state: ProviderState = {
    blob: 'blob-base',
    branches: ['main'],
    proposed: undefined,
    request: undefined,
    deployments: {},
    lookupMisses: 0,
    lookupCommit: undefined,
    answers: {},
    ...start,
  };
  const sent: SentRequest[] = [];
  const waits: number[] = [];
  const recorded: string[] = [];
  const deps: BindingDependencies = {
    transport: (request) => {
      const body =
        request.body === undefined
          ? {}
          : (JSON.parse(new TextDecoder().decode(request.body)) as Record<string, string>);
      const seen: SentRequest = {
        method: request.method ?? 'GET',
        host: request.url.hostname,
        target: `${request.url.pathname}${request.url.search}`,
        authorization: request.headers['authorization'],
        body,
      };
      sent.push(seen);
      return Promise.resolve(route(state, request, seen));
    },
    resolve: (host) =>
      Promise.resolve([host === 'api.vercel.com' ? '76.76.21.21' : '140.82.112.6']),
    credential: (entry) => Promise.resolve(`token-${entry}`),
    record: (code) => recorded.push(code),
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
  return { state, sent, waits, recorded, deps };
}

// One correction's proposal on the double: its file, seam, page and binding.
export const BEFORE = '<p>We are a friendly studio.</p>\n';
export const AFTER = '<p>We are a welcoming studio.</p>\n';
export const SEAM = 'seam-5b0e';
export const PAGE = 'https://agency.example/about/';

/** The approved version: its change, its pin, and its digest. */
export const VERSION_PIN: VersionPin = {
  target: { path: 'src/pages/about.md', word: 'friendly', replacement: 'welcoming' },
  change: { files: [{ path: 'src/pages/about.md', before: BEFORE, after: AFTER }] },
  preImageDigest: contentDigest(BEFORE),
  baseRevision: 'base-commit',
  pageUrl: PAGE,
};
export const DIGEST: string = versionDigestOf(VERSION_PIN);
/** The publish of the approved version on the correction's seam. */
export const APPROVED: { readonly seam: string; readonly versionDigest: string } = {
  seam: SEAM,
  versionDigest: DIGEST,
};

export const binding: SiteBinding = {
  repository: REPOSITORY,
  path: 'src/pages/about.md',
  defaultBranch: 'main',
  project: PROJECT,
  pageUrl: PAGE,
  proposal: { branch: SEAM, request: '17', head: HEAD, versionDigest: DIGEST },
  change: { before: BEFORE, after: AFTER },
};

export const proposed = (): Provider =>
  provider({
    content: BEFORE,
    branches: ['main', SEAM],
    proposed: AFTER,
    request: { number: 17, head: HEAD, merged: false },
  });

export const proposal: ProposeInput = {
  repository: REPOSITORY,
  path: 'src/pages/about.md',
  defaultBranch: 'main',
  branch: SEAM,
  baseRevision: 'base-commit',
  blob: 'blob-base',
  after: AFTER,
  versionDigest: DIGEST,
};

export const line = (sent: { method: string; target: string }): string =>
  `${sent.method} ${sent.target}`;
