// SPDX-License-Identifier: AGPL-3.0-only
//
// The world the edited-before-Launch cases (#1693, gap 2) run in, on the
// runner world (`site-runner-world.ts`): a double of the repository holding
// each commit's files and the default branch's head, the locate's source host
// answering from it through custody, and the runner's ports, whose proposal
// reads the head and the file from the repository and whose every write goes
// to the providers' double. An edit of the About page is a new commit and the
// providers' file and blob together, so every read agrees on it.

import { createHash, randomBytes } from 'node:crypto';
import type { Sites } from '../../apps/site-runner/runner.ts';
import type { SitePorts } from '../../apps/site-runner/sites.ts';
import { siteRunnerPorts } from '../../packages/core-commands/src/index.ts';
import type {
  BindingDependencies,
  TransportRequest,
} from '../../packages/core-connectors/src/index.ts';
import type { CustodyOutcome } from '../../packages/core-custody/src/index.ts';
import { ABOUT, BEFORE } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import { provider, REPOSITORY, type Provider } from './c80-site-provider.ts';
import { HEAD_COMMIT, sourceDouble, type SourceDouble } from './locate-world.ts';
import { time, type World } from './site-runner-world.ts';

/** Another file of the site, never the corrected page's. */
export const OTHER = 'src/pages/contact.md';
export const CONTACT = '---\ntitle: Contact\n---\n\nWrite to us any time.\n';
/** The About page as someone edited it after the stamp: the word is still there. */
export const EDITED: string = BEFORE.replace('a friendly studio.', 'a friendly studio by the sea.');

/** A blob as git names one: the SHA-1 of its header and its bytes. */
export const blobOf = (content: string): string => {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest('hex');
};

export interface Repository {
  head: string;
  readonly commits: Map<string, Readonly<Record<string, string>>>;
}

/** A new commit on the default branch with `files` changed: the head moves to it. */
export function commit(repository: Repository, files: Readonly<Record<string, string>>): void {
  const sha = randomBytes(20).toString('hex');
  repository.commits.set(sha, { ...repository.commits.get(repository.head), ...files });
  repository.head = sha;
}

const answered = (body: unknown): CustodyOutcome => ({
  kind: 'answered',
  started: true,
  outbound: { ok: true, status: 200, body: JSON.stringify(body), mediaType: 'application/json' },
  credentialKind: 'api_key',
  account: null,
});
const NOT_THERE: CustodyOutcome = {
  kind: 'answered',
  started: true,
  outbound: { ok: false, fault: 'status', status: 404 },
  credentialKind: 'api_key',
  account: null,
};

/** The locate's source host behind custody, answering from the repository at the commit asked. */
function locateOn(repository: Repository): SourceDouble {
  const double = sourceDouble({});
  const custody: SitePorts['custody'] = {
    dispatch: (_ref, request) => {
      double.requests.push(`${request.method} ${request.path}`);
      const url = new URL(request.path, 'https://source.invalid');
      if (url.pathname.includes('/git/ref/heads/'))
        return Promise.resolve(
          answered({ ref: 'refs/heads/main', object: { sha: repository.head } }),
        );
      const path = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
      const content = repository.commits.get(url.searchParams.get('ref') ?? '')?.[path];
      if (content === undefined) return Promise.resolve(NOT_THERE);
      const encoded = Buffer.from(content, 'utf8').toString('base64');
      return Promise.resolve(
        answered({ sha: blobOf(content), content: encoded, encoding: 'base64', size: 1 }),
      );
    },
  };
  return { ...double, ports: { ...double.ports, custody } };
}

export interface Edited {
  readonly world: World;
  readonly repository: Repository;
  readonly locate: SourceDouble;
  /** The status the provider answered each contents write on the default branch with. */
  readonly published: number[];
  /** `edit` runs once, just before the publish's contents write reaches the provider. */
  readonly beforePublish: { edit: (() => void) | undefined };
}

const NOT_CATALOGUED = { kind: 'refused', code: 'SEAM_READ_NOT_CATALOGUED' } as const;

/** The publish: the contents write on the default branch. */
function isPublish(request: TransportRequest): boolean {
  if (request.method !== 'PUT' || request.body === undefined) return false;
  if (request.url.pathname !== `/repos/${REPOSITORY}/contents/${ABOUT}`) return false;
  const body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
  return body['branch'] === 'main';
}

const html = (text: string): Uint8Array =>
  new TextEncoder().encode(`<!doctype html><html><body><main>${text}</main></body></html>`);

/** The providers' transport, `edit` run just before the publish's write, each publish's status kept. */
function watched(
  site: Provider,
  published: number[],
  beforePublish: Edited['beforePublish'],
): BindingDependencies {
  return {
    ...site.deps,
    transport: async (request) => {
      const publishing = isPublish(request);
      if (publishing) {
        const { edit } = beforePublish;
        beforePublish.edit = undefined;
        edit?.();
      }
      const answer = await site.deps.transport(request);
      if (publishing) published.push(answer.kind === 'answer' ? answer.status : 0);
      return answer;
    },
  };
}

/** The proposal's ports: the head and the file read from the repository, writes to the providers. */
const proposeOn =
  (repository: Repository, deps: BindingDependencies): Sites['propose'] =>
  (_site, path, raiseTask) => ({
    connector: deps,
    head: () => Promise.resolve({ kind: 'ok', value: repository.head } as const),
    file: (at) => {
      const content = repository.commits.get(at)?.[path];
      return Promise.resolve(
        content === undefined
          ? NOT_CATALOGUED
          : ({ kind: 'ok', value: { blob: blobOf(content), content } } as const),
      );
    },
    branch: () => Promise.resolve(NOT_CATALOGUED),
    request: () => Promise.resolve(NOT_CATALOGUED),
    raiseTask,
  });

/** The publish's ports on the providers, the fence's transport serving the providers' file. */
const publishOn =
  (site: Provider, deps: BindingDependencies, captured: string[]): Sites['publish'] =>
  (binding, raiseTask) =>
    siteRunnerPorts(binding, {
      ...deps,
      capture: {
        ...doubles().capture,
        transport: (request) => {
          captured.push(request.url.href);
          return Promise.resolve({
            kind: 'answer' as const,
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: html(site.state.content),
          });
        },
      },
      raiseTask,
      now: () => time.clock,
    });

/**
 * The repository at its first commit (the About page and another file), the providers holding
 * the same About page and blob, and the runner's ports on both.
 */
export function edited(): Edited {
  const repository: Repository = {
    head: HEAD_COMMIT,
    commits: new Map([[HEAD_COMMIT, { [ABOUT]: BEFORE, [OTHER]: CONTACT }]]),
  };
  const site = provider({ content: BEFORE, blob: blobOf(BEFORE) });
  const captured: string[] = [];
  const published: number[] = [];
  const beforePublish: Edited['beforePublish'] = { edit: undefined };
  const deps = watched(site, published, beforePublish);
  const sites: Sites = {
    propose: proposeOn(repository, deps),
    publish: publishOn(site, deps, captured),
  };
  return {
    world: { site, sites, raised: [], captured },
    repository,
    locate: locateOn(repository),
    published,
    beforePublish,
  };
}

/** The About page edited on the default branch: a new commit, and the providers' file and blob. */
export function editAbout(given: Edited, content: string): void {
  commit(given.repository, { [ABOUT]: content });
  given.world.site.state.content = content;
  given.world.site.state.blob = blobOf(content);
}
