// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's composition (`docs/local/SITE-RUNNER.md`): each pass takes the leases its
// claims hold, proposes each approved correction once (`proposeCorrection`),
// binds the publish to that proposal (`siteBindingFor`) and runs it
// (`runLivePublish`). A publish recorded `accepted` is followed, one run per
// pass, until it reads `live` or `unknown`, and for at most `FOLLOW_FOR_MS`.
// Every guarantee about sending is the library's: this file chooses what runs
// and with which ports, and holds no credential and no transaction.

import {
  proposalForBinding,
  proposeCorrection,
  runLivePublish,
  type CorrectionRun,
  type ProposePorts,
  type RunnerPorts,
} from '../../packages/core-commands/src/index.ts';
import {
  readCorrectionForRun,
  readPartySite,
  type BusinessId,
  type Database,
  type LiveCorrection,
  type PartySiteRecord,
} from '../../packages/core-records/src/index.ts';
import {
  approvedChange,
  contentDigest,
  siteBindingFor,
  type SiteBinding,
} from '../../packages/core-connectors/src/index.ts';

/** How often the host runs a pass, so a followed publish is observed again. */
export const FOLLOW_EVERY_MS = 15_000;
/** How long a publish is followed from the first `accepted` this process saw. */
export const FOLLOW_FOR_MS = 600_000;

/** A lease on a correction's task, taken through the queue, with the correction it runs. */
export interface Claim {
  readonly correctionId: string;
  readonly taskId: string;
  readonly leaseId: string;
  readonly fence: number;
}

/** The queue and the lease: `task.queue` and `task.pickup`, `task.heartbeat`, `task.handback`. */
export interface Claims {
  /** Leases newly taken on queued site work. */
  readonly take: () => Promise<readonly Claim[]>;
  /** The lease renewed; false once it is lost. */
  readonly beat: (claim: Claim) => Promise<boolean>;
  /** The lease handed back with the claim's last outcome: `live`, a refusal's code or `LEASE_LOST`. */
  readonly release: (claim: Claim, outcome: string) => Promise<void>;
}

/** The provider ports, every call guarded and every credential borrowed from custody. */
export interface Sites {
  readonly propose: (
    site: PartySiteRecord,
    path: string,
    raiseTask: (reason: string) => Promise<void>,
  ) => ProposePorts;
  /** Fresh ports for one run of `runLivePublish`. */
  readonly publish: (
    binding: SiteBinding,
    raiseTask: (reason: string) => Promise<void>,
  ) => RunnerPorts;
}

export interface SiteRunnerDeps {
  readonly db: Database;
  readonly business: BusinessId;
  /** The runner's agent actor, from its API session: every lease read compares it. */
  readonly actorId: string;
  readonly claims: Claims;
  readonly sites: Sites;
  /** One person task on the claim's task, naming the reason. */
  readonly raiseTask: (claim: Claim, reason: string) => Promise<void>;
  readonly now: () => number;
}

/** What one pass did with one claim: the state recorded, a refusal's code, or still following. */
export interface Passed {
  readonly correctionId: string;
  readonly outcome: string;
}

interface Followed {
  readonly claim: Claim;
  readonly binding: SiteBinding;
  /** When this process first saw the publish recorded `accepted`: unset until then. */
  readonly since?: number;
}

type Held =
  | { readonly ok: true; readonly correction: LiveCorrection; readonly site: PartySiteRecord }
  | { readonly ok: false; readonly code: string };

/** The correction and its party's site, read under the lease. */
async function heldUnder(db: Database, run: CorrectionRun): Promise<Held> {
  return await db.withBusiness(run.business, async (tx) => {
    const read = await readCorrectionForRun(tx, run);
    if (!read.ok) return read;
    const site = await readPartySite(tx, read.correction.partyId);
    if (site === undefined) return { ok: false, code: 'PAGE_OUTSIDE_PARTY_SITE' } as const;
    return { ok: true, correction: read.correction, site } as const;
  });
}

/**
 * The publish's binding: the proposal made under this lease, and the approved
 * bytes rebuilt from the file at the base revision, checked against the pin.
 */
async function bindingOf(
  db: Database,
  run: CorrectionRun,
  { correction, site }: Extract<Held, { ok: true }>,
  file: ProposePorts['file'],
): Promise<SiteBinding | string> {
  const proposed = await proposalForBinding(db, run);
  if (!proposed.ok) return proposed.code;
  const base = await file(correction.baseRevision);
  if (base.kind !== 'ok') return 'CONTENT_DRIFT_UNCHECKED';
  if (contentDigest(base.value.content) !== correction.preImageDigest) return 'CONTENT_DRIFTED';
  const {
    targetPath: path,
    word,
    replacement,
    preImageDigest,
    baseRevision,
    pageUrl,
    seam,
  } = correction;
  const version = {
    target: { path, word, replacement },
    preImageDigest,
    baseRevision,
    pageUrl,
    seam,
  };
  const after = approvedChange(version, base.value.content, correction.versionDigest)?.files[0]
    ?.after;
  if (typeof after !== 'string') return 'PROPOSAL_SUPERSEDED';
  const change = { before: base.value.content, after };
  const made = siteBindingFor(site, correction, { proposal: proposed.proposal, change, version });
  return made.ok ? made.binding : made.code;
}

interface Runner {
  readonly deps: SiteRunnerDeps;
  readonly following: Map<string, Followed>;
}

const runOf = ({ deps }: Runner, claim: Claim): CorrectionRun => ({
  business: deps.business,
  correctionId: claim.correctionId,
  leaseId: claim.leaseId,
  fence: claim.fence,
  actorId: deps.actorId,
});

const raising =
  ({ deps }: Runner, claim: Claim) =>
  async (reason: string): Promise<void> =>
    await deps.raiseTask(claim, reason);

/** The claim ended and its lease handed back; a lease lost at any step raises its person task. */
async function settle(runner: Runner, claim: Claim, outcome: string): Promise<Passed> {
  runner.following.delete(claim.correctionId);
  const lost = outcome === 'LEASE_NOT_OWNED';
  if (lost) await raising(runner, claim)('LEASE_LOST');
  const settled = lost ? 'LEASE_LOST' : outcome;
  await runner.deps.claims.release(claim, settled);
  return { correctionId: claim.correctionId, outcome: settled };
}

/** One run of the publish; `accepted` keeps it followed until the cap. */
async function publish(runner: Runner, { claim, binding, since }: Followed): Promise<Passed> {
  const { deps } = runner;
  const raise = raising(runner, claim);
  const ports = deps.sites.publish(binding, raise);
  const result = await runLivePublish(deps.db, runOf(runner, claim), ports);
  const outcome = result.kind === 'recorded' ? result.state : result.code;
  if (outcome !== 'accepted') return await settle(runner, claim, outcome);
  // The window opens once the first run has returned accepted, so its own sends and reads take none of it.
  if (since === undefined) {
    runner.following.set(claim.correctionId, { claim, binding, since: deps.now() });
    return { correctionId: claim.correctionId, outcome: 'following' };
  }
  if (deps.now() - since >= FOLLOW_FOR_MS) {
    await raise('LIVE_CHECK_TIMED_OUT');
    return await settle(runner, claim, 'LIVE_CHECK_TIMED_OUT');
  }
  runner.following.set(claim.correctionId, { claim, binding, since });
  return { correctionId: claim.correctionId, outcome: 'following' };
}

/** A new claim: proposed once while approved (or refused unapproved), then bound and published. */
async function start(runner: Runner, claim: Claim): Promise<Passed> {
  const { deps } = runner;
  const run = runOf(runner, claim);
  const held = await heldUnder(deps.db, run);
  if (!held.ok) return await settle(runner, claim, held.code);
  const ports = deps.sites.propose(held.site, held.correction.targetPath, raising(runner, claim));
  if (held.correction.state === 'approved' || held.correction.state === 'requested') {
    const proposed = await proposeCorrection(deps.db, run, ports);
    if (proposed.kind === 'refused') return await settle(runner, claim, proposed.code);
  }
  const binding = await bindingOf(deps.db, run, held, ports.file);
  if (typeof binding === 'string') return await settle(runner, claim, binding);
  return await publish(runner, { claim, binding });
}

/** A followed publish run again, its lease renewed first. */
async function again(runner: Runner, followed: Followed): Promise<Passed> {
  if (!(await runner.deps.claims.beat(followed.claim)))
    return await settle(runner, followed.claim, 'LEASE_NOT_OWNED');
  return await publish(runner, followed);
}

export function createSiteRunner(deps: SiteRunnerDeps): { pass(): Promise<readonly Passed[]> } {
  const runner: Runner = { deps, following: new Map() };
  return {
    async pass() {
      const passed: Passed[] = [];
      // One at a time: each run reads and writes under its own lease, and no two share a send.
      for (const followed of runner.following.values()) {
        // oxlint-disable-next-line no-await-in-loop
        passed.push(await again(runner, followed));
      }
      for (const claim of await deps.claims.take()) {
        if (runner.following.has(claim.correctionId)) continue;
        // oxlint-disable-next-line no-await-in-loop
        passed.push(await start(runner, claim));
      }
      return passed;
    },
  };
}
