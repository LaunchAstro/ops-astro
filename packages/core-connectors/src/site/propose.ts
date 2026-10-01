// SPDX-License-Identifier: AGPL-3.0-only
//
// `site.source.propose`, composed: the branch named by the correction's seam
// (`site.source.propose.branch`), the one file written on it
// (`site.source.propose`, the contents write), and the request opened from
// it (`site.source.propose.request`). Each is a guarded call through
// `callConnector`, in that order, each only after the one before answered.
//
// Only the first write can prove nothing happened: a refused branch (one that
// already exists included) is that refusal, with nothing else sent. Once the
// branch is made, any later step that does not answer leaves a partial
// proposal, so the composition is `unknown`, read back by the branch name it
// named before dispatch, never `failed`. Nothing here merges: the proposal is
// reversible by deleting its branch.

import { callConnector, type CallDependencies, type ProviderResult } from '../call.ts';
import { siteOperation } from './operations.ts';

export interface ProposeInput {
  readonly repository: string;
  readonly path: string;
  readonly defaultBranch: string;
  /** The correction's seam: the branch name, named before dispatch. */
  readonly branch: string;
  /** The commit the pre-image was pinned at; the branch starts here. */
  readonly baseRevision: string;
  /** The site file's blob at that commit, as `site.source.read` answered it. */
  readonly blob: string;
  /** The approved bytes. */
  readonly after: string;
  /** The version those bytes are; the proposal carries it to the publish. */
  readonly versionDigest: string;
}

export type Proposed = ProviderResult<{
  readonly request: string;
  readonly head: string;
  readonly versionDigest: string;
}>;

function incomplete(code: string, deps: CallDependencies): Proposed {
  deps.record('PROPOSAL_INCOMPLETE');
  return { kind: 'unknown', code };
}

/** Branch, commit, request: the three guarded writes of one proposal. */
export async function proposeSource(
  input: ProposeInput,
  deps: CallDependencies,
): Promise<Proposed> {
  const { repository, branch } = input;
  const made = await callConnector(
    siteOperation('site.source.propose.branch'),
    { repository, ref: `refs/heads/${branch}`, sha: input.baseRevision },
    deps,
  );
  if (made.kind !== 'ok') return made;
  const committed = await callConnector(
    siteOperation('site.source.propose'),
    {
      repository,
      path: input.path,
      message: `Live correction ${branch}`,
      content: Buffer.from(input.after, 'utf8').toString('base64'),
      sha: input.blob,
      branch,
    },
    deps,
  );
  if (committed.kind !== 'ok') return incomplete(committed.code, deps);
  const opened = await callConnector(
    siteOperation('site.source.propose.request'),
    { repository, title: `Live correction ${branch}`, head: branch, base: input.defaultBranch },
    deps,
  );
  if (opened.kind !== 'ok') return incomplete(opened.code, deps);
  return {
    kind: 'ok',
    value: {
      request: String(opened.value['number']),
      head: String(committed.value['commit.sha']),
      versionDigest: input.versionDigest,
    },
  };
}
