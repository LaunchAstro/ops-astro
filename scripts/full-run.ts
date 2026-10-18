// SPDX-License-Identifier: AGPL-3.0-only
//
// Merge-queue CI hygiene (owner, 12 October 2026, NATHAN-CF-SPEED item 4):
// which of ci.yml's two sets this run takes. The gate's first step prints
// `scope=full` or `scope=light` to its outputs; the `full checks` job runs
// unless the scope is `light`, and every heavy job waits on it, so a light run
// skips them. The three required aggregates read the scope and say why.
//
//   merge group   always full. Nothing here can make a group light.
//   pull request  full only while the pull request carries the `ci-next`
//                 label, which the orchestrator adds when it is next for Sol
//                 or the merge queue; light otherwise, and the aggregates fail
//                 saying so. A label change on a closed pull request runs
//                 nothing at all (the gate's own guard).
//   push to main  light when a green merge-group run of ci.yml already tested
//                 this exact tree and the queue still holds entries; full
//                 when nothing tested it, or the queue is empty, which is the
//                 end of a batch.
//
// Anything it cannot read is full: a mistake here costs runner time, never a
// check.

import { appendFileSync, readFileSync } from 'node:fs';

export const LABEL = 'ci-next';
export const FULL = 'full';
export const LIGHT = 'light';
export type Scope = typeof FULL | typeof LIGHT;
const WORKFLOW = '.github/workflows/ci.yml';

/** A workflow run as the runs list returns it, every field possibly absent. */
export interface Run {
  readonly id?: number;
  readonly event?: string;
  readonly path?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly repository?: { readonly full_name?: string } | null;
  readonly head_commit?: { readonly tree_id?: string } | null;
}

/** A GET against the REST API, answering the parsed body. */
export type Api = (path: string) => Promise<unknown>;
/** A GraphQL query, answering the parsed body. */
export type GraphQL = (query: string, variables: Record<string, string>) => Promise<unknown>;

/** A field of an object, or undefined when either is not there. */
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** The scope for this event. `tested` and `queueBusy` are read for a push alone. */
export function scopeOf({
  eventName,
  payload,
  tested,
  queueBusy,
}: {
  eventName: string;
  payload?: unknown;
  tested?: boolean | undefined;
  queueBusy?: boolean | undefined;
}): Scope {
  if (eventName === 'pull_request') {
    const labels = field(field(payload, 'pull_request'), 'labels');
    if (!Array.isArray(labels)) return FULL;
    return labels.some((label) => field(label, 'name') === LABEL) ? FULL : LIGHT;
  }
  if (eventName === 'push') return tested === true && queueBusy === true ? LIGHT : FULL;
  // A merge group, and any event this file does not know.
  return FULL;
}

/**
 * The green merge-group run of ci.yml whose head carries `tree`, or undefined.
 * A run still going on that tree is waited for, up to `waits` reads apart by
 * `pause`, since the queue pushes main seconds after its checks report.
 */
export async function testedBy({
  api,
  repo,
  tree,
  waits = 12,
  pause,
}: {
  api: Api;
  repo: string;
  tree: string | undefined;
  waits?: number;
  pause: () => Promise<void>;
}): Promise<Run | undefined> {
  // A tree it could not read matches nothing, not every run without one.
  if (typeof tree !== 'string' || tree === '') return undefined;
  for (let read = 0; ; read += 1) {
    // eslint-disable-next-line no-await-in-loop -- one read after another, a pause apart
    const page = await api(
      `/repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&per_page=50`,
    );
    const runs = field(page, 'workflow_runs');
    const same = (Array.isArray(runs) ? (runs as Run[]) : []).filter(
      (run) =>
        run?.head_commit?.tree_id === tree &&
        run?.path === WORKFLOW &&
        run?.repository?.full_name === repo &&
        run?.event === 'merge_group',
    );
    const green = same.find((run) => run.status === 'completed' && run.conclusion === 'success');
    if (green !== undefined) return green;
    if (!same.some((run) => run.status !== 'completed') || read >= waits) return undefined;
    // eslint-disable-next-line no-await-in-loop -- the wait between two reads
    await pause();
  }
}

/**
 * Whether the merge queue into main holds an entry, by the queue's own count. A queue it cannot
 * read holds none, so the push takes the full set: a run still going cannot tell a live group from
 * one already merged through a later group, and is only named in the log.
 */
export async function queueBusyNow({
  api,
  graphql,
  repo,
}: {
  api: Api;
  graphql: GraphQL;
  repo: string;
}): Promise<boolean> {
  const [owner = '', name = ''] = repo.split('/');
  let entries: unknown;
  try {
    const answer = await graphql(
      'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) ' +
        '{ mergeQueue(branch: "main") { entries(first: 1) { totalCount } } } }',
      { owner, name },
    );
    const queue = field(field(field(answer, 'data'), 'repository'), 'mergeQueue');
    entries = field(field(queue, 'entries'), 'totalCount');
  } catch {
    entries = undefined;
  }
  // The queue's own count decides. A merged group's run can still be going after the queue empties
  // (two groups built at once merge through the later one), so a run going is no count.
  if (typeof entries === 'number') return entries > 0;
  const going = await Promise.all(
    ['queued', 'in_progress'].map(
      async (status) =>
        await api(
          `/repos/${repo}/actions/workflows/ci.yml/runs?event=merge_group&status=${status}&per_page=1`,
        ),
    ),
  );
  const runs = going.reduce<number>(
    (sum, page) => sum + Number(field(page, 'total_count') ?? 0),
    0,
  );
  console.log(
    `full run: the merge queue could not be read (${String(runs)} merge group run(s) queued or ` +
      'going, which may be merged already); the full set runs',
  );
  return false;
}

/** A tested push's scope at the end of a batch: full when the queue is empty, light while it holds more. */
export async function batchEnd({
  api,
  graphql,
  repo,
}: {
  api: Api;
  graphql: GraphQL;
  repo: string;
  sha: string;
  pause: () => Promise<void>;
  waits?: number;
}): Promise<Scope> {
  if (!(await queueBusyNow({ api, graphql, repo }))) {
    console.log('full run: the merge queue is empty, the end of a batch; the full set runs');
    return FULL;
  }
  console.log('full run: the queue holds more; the light set runs');
  return LIGHT;
}

/** The wait between two reads of the queue and main. */
async function wait(): Promise<void> {
  await new Promise((done) => {
    setTimeout(done, 30_000);
  });
}

function client(token: string, base: string): { api: Api; graphql: GraphQL } {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  };
  const api: Api = async (path) => {
    const answer = await fetch(`${base}${path}`, { headers });
    if (!answer.ok) throw new Error(`GET ${path}: ${String(answer.status)}`);
    return (await answer.json()) as unknown;
  };
  const graphql: GraphQL = async (query, variables) => {
    const answer = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!answer.ok) throw new Error(`graphql: ${String(answer.status)}`);
    return (await answer.json()) as unknown;
  };
  return { api, graphql };
}

async function decide(env: NodeJS.ProcessEnv): Promise<Scope> {
  const eventName = env['GITHUB_EVENT_NAME'] ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(env['GITHUB_EVENT_PATH'] ?? '', 'utf8'));
  } catch {
    console.log('full run: no event to read; the full set runs');
    return FULL;
  }
  if (eventName !== 'push') {
    const scope = scopeOf({ eventName, payload });
    console.log(
      scope === LIGHT
        ? `full run: this pull request has no '${LABEL}' label, so the light set runs; ` +
            `the orchestrator adds '${LABEL}' when it is next for Sol or the merge queue`
        : `full run: ${eventName}; the full set runs`,
    );
    return scope;
  }
  return await pushScope(env);
}

/** A push to main's scope: light only when its tree was tested and the queue holds more. */
async function pushScope(env: NodeJS.ProcessEnv): Promise<Scope> {
  try {
    const repo = env['GITHUB_REPOSITORY'] ?? '';
    const { api, graphql } = client(env['GH_TOKEN'] ?? '', env['GITHUB_API_URL'] ?? '');
    const commit = await api(`/repos/${repo}/git/commits/${env['GITHUB_SHA'] ?? ''}`);
    const tree = field(field(commit, 'tree'), 'sha');
    const tested = await testedBy({
      api,
      repo,
      tree: typeof tree === 'string' ? tree : undefined,
      pause: async () => {
        await new Promise((done) => {
          setTimeout(done, 15_000);
        });
      },
    });
    if (tested === undefined) {
      console.log('full run: no green merge group tested this tree; the full set runs');
      return FULL;
    }
    console.log(`full run: merge group run ${String(tested.id)} tested this tree`);
    return await batchEnd({ api, graphql, repo, sha: env['GITHUB_SHA'] ?? '', pause: wait });
  } catch (error) {
    console.log(
      `full run: ${error instanceof Error ? error.message : String(error)}; the full set runs`,
    );
    return FULL;
  }
}

if (import.meta.main) {
  const scope = await decide(process.env);
  appendFileSync(process.env['GITHUB_OUTPUT'] ?? '/dev/stdout', `scope=${scope}\n`);
}
