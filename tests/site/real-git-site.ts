// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the source control provider backed by a real bare Git
// repository, made with the `git` CLI in a fresh temporary folder. It answers
// the GitHub routes the site binding sends (contents read and write, a
// branch's ref read and fast-forward update, branch protection) from that
// repository, and the hosting lookup with no deployment. Every request is kept
// as sent, as the in-memory double keeps them. A ref only ever moves forward
// through a request: the fast-forward is `git merge-base --is-ancestor`, and a
// force is refused. Test setup moves refs directly (`rewrite`), as a rewrite
// made before protection was turned on. Nothing leaves the process.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BindingDependencies,
  TransportAnswer,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';
import { REPOSITORY, json, type SentRequest } from './c80-site-provider.ts';

/** What `GET branches/{b}/protection` answers: GitHub's shape, or 404 when undefined. */
export interface Protection {
  readonly allow_force_pushes: { readonly enabled: boolean };
  readonly allow_deletions: { readonly enabled: boolean };
  readonly enforce_admins: { readonly enabled: boolean };
}

export const ENFORCED: Protection = {
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  enforce_admins: { enabled: true },
};

export interface RealGitSite {
  readonly sent: SentRequest[];
  readonly waits: number[];
  readonly recorded: string[];
  readonly deps: BindingDependencies;
  /** Branch protection answers, by branch; a branch absent answers 404. */
  readonly protection: Record<string, Protection>;
  /** One commit on `parent` (or a root commit), each file set or removed (null); its sha. */
  readonly commit: (
    parent: string | undefined,
    files: Readonly<Record<string, string | null>>,
    message: string,
  ) => string;
  /** Points a branch at a commit, outside any request: test setup only. */
  readonly rewrite: (branch: string, sha: string) => void;
  /** The commit a branch points at, or undefined. */
  readonly head: (branch: string) => string | undefined;
  /** A file's text at a ref, or undefined when absent. */
  readonly fileAt: (ref: string, path: string) => string | undefined;
  readonly dispose: () => void;
}

type Body = Readonly<Record<string, unknown>>;

const PINNED_DATE = '2026-01-01T00:00:00+0000';

/** One bare repository and the pinned environment every `git` call runs in. */
interface Repository {
  readonly root: string;
  /** Git's output as printed, for a blob's bytes. */
  readonly raw: (args: readonly string[], input?: string, extra?: NodeJS.ProcessEnv) => string;
  /** Git's output with the trailing line break dropped. */
  readonly git: (args: readonly string[], input?: string, extra?: NodeJS.ProcessEnv) => string;
  readonly succeeds: (args: readonly string[]) => boolean;
}

function repositoryIn(root: string): Repository {
  const bare = join(root, 'site.git');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'no-config'),
    GIT_AUTHOR_NAME: 'Site Author',
    GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_AUTHOR_DATE: PINNED_DATE,
    GIT_COMMITTER_NAME: 'Site Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    GIT_COMMITTER_DATE: PINNED_DATE,
  };
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare], { env });
  const raw = (args: readonly string[], input?: string, extra: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', ['--git-dir', bare, ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
    });
  const git = (args: readonly string[], input?: string, extra: NodeJS.ProcessEnv = {}) =>
    raw(args, input, extra).trimEnd();
  const succeeds = (args: readonly string[]) => {
    try {
      git(args);
      return true;
    } catch {
      return false;
    }
  };
  return { root, raw, git, succeeds };
}

function headOf(repo: Repository, branch: string): string | undefined {
  const ref = `refs/heads/${branch}`;
  return repo.succeeds(['rev-parse', '--verify', '--quiet', ref])
    ? repo.git(['rev-parse', '--verify', ref])
    : undefined;
}

function blobAt(repo: Repository, ref: string, path: string): string | undefined {
  return repo.succeeds(['cat-file', '-e', `${ref}:${path}`])
    ? repo.git(['rev-parse', `${ref}:${path}`])
    : undefined;
}

function fileAt(repo: Repository, ref: string, path: string): string | undefined {
  const blob = blobAt(repo, ref, path);
  return blob === undefined ? undefined : repo.raw(['cat-file', 'blob', blob]);
}

function commitOn(
  repo: Repository,
  parent: string | undefined,
  files: Readonly<Record<string, string | null>>,
  message: string,
): string {
  const index = { GIT_INDEX_FILE: join(repo.root, 'index') };
  repo.git(parent === undefined ? ['read-tree', '--empty'] : ['read-tree', parent], '', index);
  for (const [path, text] of Object.entries(files)) {
    // Mode 0 removes the entry; a bare repository has no work tree for `--force-remove`.
    if (text === null)
      repo.git(['update-index', '--index-info'], `0 ${'0'.repeat(40)}\t${path}\n`, index);
    else {
      const blob = repo.git(['hash-object', '-w', '--stdin'], text);
      repo.git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], '', index);
    }
  }
  const tree = repo.git(['write-tree'], '', index);
  const parents = parent === undefined ? [] : ['-p', parent];
  return repo.git(['commit-tree', tree, ...parents, '-m', message]);
}

/** `GET contents/{path}?ref=`: the file at the branch's head. */
function readContents(repo: Repository, path: string, query: URLSearchParams): TransportAnswer {
  const at = headOf(repo, query.get('ref') ?? 'main');
  const blob = at === undefined ? undefined : blobAt(repo, at, path);
  if (blob === undefined) return json({ message: 'Not Found' }, 404);
  const text = repo.raw(['cat-file', 'blob', blob]);
  const content = Buffer.from(text, 'utf8').toString('base64');
  return json({ sha: blob, content, encoding: 'base64', path, size: Buffer.byteLength(text) });
}

/** `PUT contents/{path}`: one new commit on the branch, at the blob the request names. */
function writeContents(repo: Repository, path: string, body: Body): TransportAnswer {
  const branch = typeof body['branch'] === 'string' ? body['branch'] : 'main';
  const parent = headOf(repo, branch);
  if (parent === undefined) return json({ message: 'Branch not found' }, 404);
  if (body['sha'] !== blobAt(repo, parent, path))
    return json({ message: `${path} does not match ${String(body['sha'])}` }, 409);
  const text = Buffer.from(String(body['content'] ?? ''), 'base64').toString('utf8');
  const made = commitOn(repo, parent, { [path]: text }, String(body['message'] ?? ''));
  repo.git(['update-ref', `refs/heads/${branch}`, made, parent]);
  return json({
    content: { sha: blobAt(repo, made, path), path },
    commit: { sha: made, parents: [{ sha: parent }] },
  });
}

/** `PATCH git/refs/heads/{b}`: a fast-forward only; anything else, a force included, is 422. */
function updateRef(repo: Repository, branch: string, body: Body): TransportAnswer {
  const current = headOf(repo, branch);
  if (current === undefined) return json({ message: 'Reference does not exist' }, 422);
  const target = typeof body['sha'] === 'string' ? body['sha'] : '';
  const forward =
    body['force'] !== true &&
    repo.succeeds(['cat-file', '-e', `${target}^{commit}`]) &&
    repo.succeeds(['merge-base', '--is-ancestor', current, target]);
  if (!forward) return json({ message: 'Update is not a fast forward' }, 422);
  repo.git(['update-ref', `refs/heads/${branch}`, target, current]);
  return json({ ref: `refs/heads/${branch}`, object: { sha: target, type: 'commit' } });
}

type SourceRoute = (
  repo: Repository,
  name: string,
  query: URLSearchParams,
  body: Body,
  protection: Readonly<Record<string, Protection>>,
) => TransportAnswer;

/** The source routes under `/repos/{repository}`, by method and path shape. */
const SOURCE_ROUTES: readonly (readonly [string, RegExp, SourceRoute])[] = [
  ['GET', /^\/contents\/(.+)$/u, (repo, path, query) => readContents(repo, path, query)],
  ['PUT', /^\/contents\/(.+)$/u, (repo, path, _query, body) => writeContents(repo, path, body)],
  [
    'GET',
    /^\/git\/ref\/heads\/([^/]+)$/u,
    (repo, branch) => {
      const sha = headOf(repo, branch);
      if (sha === undefined) return json({ message: 'Not Found' }, 404);
      return json({ ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
    },
  ],
  ['PATCH', /^\/git\/refs\/heads\/([^/]+)$/u, (repo, b, _q, body) => updateRef(repo, b, body)],
  [
    'GET',
    /^\/branches\/([^/]+)\/protection$/u,
    (_repo, branch, _query, _body, protection) => {
      const answer = protection[branch];
      return answer === undefined ? json({ message: 'Branch not protected' }, 404) : json(answer);
    },
  ],
];

/** Records each request as sent, answers it by `route`, and borrows no real credential. */
function recording(
  route: (request: TransportRequest, seen: SentRequest, body: Body) => TransportAnswer,
): Pick<RealGitSite, 'sent' | 'waits' | 'recorded' | 'deps'> {
  const sent: SentRequest[] = [];
  const waits: number[] = [];
  const recorded: string[] = [];
  const deps: BindingDependencies = {
    transport: (request) => {
      const body: Body =
        request.body === undefined
          ? {}
          : (JSON.parse(new TextDecoder().decode(request.body)) as Body);
      const seen: SentRequest = {
        method: request.method ?? 'GET',
        host: request.url.hostname,
        target: `${request.url.pathname}${request.url.search}`,
        authorization: request.headers['authorization'],
        body: body as Readonly<Record<string, string>>,
      };
      sent.push(seen);
      return Promise.resolve(route(request, seen, body));
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
  return { sent, waits, recorded, deps };
}

/** The real Git site, one repository named `repository` with no branches yet. */
export function realGitSite(repository: string = REPOSITORY): RealGitSite {
  const root = mkdtempSync(join(tmpdir(), 'real-git-site-'));
  const repo = repositoryIn(root);
  const protection: Record<string, Protection> = {};
  const prefix = `/repos/${repository}`;
  const route = (request: TransportRequest, seen: SentRequest, body: Body): TransportAnswer => {
    const { pathname, searchParams } = request.url;
    if (seen.host === 'api.vercel.com' && seen.method === 'GET' && pathname === '/v6/deployments')
      return json({ deployments: [], pagination: {} });
    if (seen.host !== 'api.github.com' || !pathname.startsWith(`${prefix}/`))
      return json({ message: 'Not Found' }, 404);
    const rest = pathname.slice(prefix.length);
    for (const [method, shape, answer] of SOURCE_ROUTES) {
      const name = method === seen.method ? shape.exec(rest)?.[1] : undefined;
      if (name !== undefined)
        return answer(repo, decodeURIComponent(name), searchParams, body, protection);
    }
    return json({ message: 'Not Found' }, 404);
  };
  return {
    ...recording(route),
    protection,
    commit: (parent, files, message) => commitOn(repo, parent, files, message),
    rewrite: (branch, sha) => void repo.git(['update-ref', `refs/heads/${branch}`, sha]),
    head: (branch) => headOf(repo, branch),
    fileAt: (ref, path) => fileAt(repo, ref, path),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
