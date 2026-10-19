// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's review captures (#2013, C35; `docs/local/SITE-RUNNER.md`, "Review
// captures"): a person's approved `review_capture` step, picked up off the queue as the
// runner's agent actor like a correction's, with a lease of its own. Under that lease it
// claims the review's captures (`review.capture_claim`), takes the page observation once and
// a picture at each width the claim handed out, all through the C18-1 fence, renews the lease
// and lands each width (`review.capture_land`). The API judges the lease, the fence and the
// rows under lock at every call; finding the review grants nothing. A claim hands out only
// the widths not yet landed, so a retry never overwrites one.
//
// Spare work: the host runs it after the corrections, one capture a pass. A queue it cannot
// read fails the pass (`QueueUnread`), as the corrections' does. A capture the fence or the
// browser refused lands nothing and hands the lease back failed with the fence's code; a
// lost lease has nothing to hand back. Only codes are printed or reported, never a path.

import {
  capturePage,
  capturePicture,
  type CaptureOptions,
  type CapturePool,
  type FenceCode,
  type PictureBrowser,
} from '../../packages/core-connectors/src/index.ts';
import {
  CAPTURE_WIDTHS,
  type BusinessId,
  type CaptureWidth,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { printable, queueOf, type AgentCall, type Answer } from './claims.ts';
import type { ConfiguredSite } from './configured.ts';

/** The purpose a person's approval gives the step that puts a review's capture on the queue. */
export const CAPTURE_PURPOSE = 'review_capture';

/** Captures taken a pass, however many wait: a review backlog never holds a correction back. */
export const CAPTURES_A_PASS = 1;

/** A browser whose window is `width` wide (`picture-browser.ts`). */
export type SizedBrowser = (width: CaptureWidth) => PictureBrowser;

export interface CaptureJob {
  readonly call: AgentCall;
  readonly db: Database;
  readonly business: BusinessId;
  /** The fence's inputs: the agency's own pages (`reviewPool`), the resolver and the transport. */
  readonly capture: CaptureOptions;
  readonly browserAt: SizedBrowser;
}

/** One capture step taken: its task, and `landed` or the code it ended on. */
export interface Captured {
  readonly taskId: string;
  readonly outcome: string;
}

/**
 * The fence's pool for review captures: the configured site's pages when that site is
 * the business's own, and nothing when it is a client's. No other page is reachable until the
 * pool's reviews are recorded (#2018).
 */
export const reviewPool = (site: ConfiguredSite, business: string): CapturePool => ({
  agencyPages: site.holder === business ? site.pages.map((page) => page.pageUrl) : [],
  otherPages: [],
  closedPoolReviews: [],
});

/** The task's oldest revision with a width not yet landed, and the page its review is of. */
async function askedOn(
  db: Database,
  business: BusinessId,
  taskId: string,
): Promise<{ readonly revisionId: string; readonly pageUrl: string } | undefined> {
  return await db.withBusiness(business, async (tx) => {
    const [row] = await tx.query<{ readonly revision_id: string; readonly page_url: string }>(
      `select v.id as revision_id, c.page_url from public.review_captures k
         join public.review_revisions v on v.business_id = k.business_id and v.id = k.revision_id
         join public.reviews c on c.business_id = v.business_id and c.id = v.review_id
        where k.business_id = $1 and c.task_id = $2 and k.state <> 'landed'
        order by v.created_at, v.id limit 1`,
      [tx.businessId, taskId],
    );
    return row === undefined ? undefined : { revisionId: row.revision_id, pageUrl: row.page_url };
  });
}

/** A refusal's code from the API, as it may be printed, or the fault it reads as when there is none. */
const codeOf = (answer: Answer, fault: string): string =>
  'refused' in answer ? printable(answer.refused) : fault;

interface Lease {
  readonly leaseId: string;
  readonly fence: number;
  readonly pickup: string;
}

interface Taken {
  readonly observation: object;
  readonly pictures: readonly (readonly [CaptureWidth, Uint8Array])[];
}

/** The observation and each width's picture, or the fence's code. */
async function taken(
  pageUrl: string,
  widths: readonly CaptureWidth[],
  job: CaptureJob,
): Promise<Taken | FenceCode> {
  const observation = await capturePage(pageUrl, job.capture);
  if (!observation.ok) return observation.code;
  const pictures: (readonly [CaptureWidth, Uint8Array])[] = [];
  for (const width of widths) {
    // oxlint-disable-next-line no-await-in-loop -- one browser at a time
    const picture = await capturePicture(pageUrl, job.capture, job.browserAt(width));
    if (!picture.ok) return picture.code;
    pictures.push([width, picture.value.png]);
  }
  return { observation: observation.value, pictures };
}

/** Claim, capture and land under `lease`: `landed`, or the code it stopped on. */
async function captureUnder(job: CaptureJob, taskId: string, lease: Lease): Promise<string> {
  const { call } = job;
  const { leaseId, fence, pickup } = lease;
  const asked = await askedOn(job.db, job.business, taskId);
  if (asked === undefined) return 'NO_CAPTURE_ASKED';
  const { revisionId } = asked;
  const claimed = await call('review.capture_claim', { leaseId, fence, revisionId }, pickup);
  if (!('detail' in claimed)) return codeOf(claimed, 'CLAIM_FAULT');
  const handed = claimed.detail['widths'];
  const widths = CAPTURE_WIDTHS.filter((width) => Array.isArray(handed) && handed.includes(width));
  const capture = await taken(asked.pageUrl, widths, job);
  if (typeof capture === 'string') return capture;
  // The pictures took a while: the lease is renewed, or nothing lands.
  if (!('detail' in (await call('task.heartbeat', { leaseId, fence }, pickup)))) {
    return 'LEASE_LOST';
  }
  for (const [width, png] of capture.pictures) {
    const picture = Buffer.from(png).toString('base64');
    const body = { leaseId, fence, revisionId, width, picture, observation: capture.observation };
    // oxlint-disable-next-line no-await-in-loop -- one width at a time
    const landed = await call('review.capture_land', body, pickup);
    if (!('detail' in landed)) return codeOf(landed, 'LAND_FAULT');
  }
  return 'landed';
}

/** One queued capture step: picked up, captured under its lease, and handed back. */
async function captureStep(
  job: CaptureJob,
  entry: Readonly<Record<string, unknown>>,
): Promise<Captured | undefined> {
  const { call } = job;
  // A pickup whose answer is lost holds a lease nobody renews: it lapses and the sweep returns it.
  const picked = await call('task.pickup', { reservationId: entry['reservationId'] });
  if (!('detail' in picked)) return undefined;
  const taskId = String(entry['taskId']);
  const lease = {
    leaseId: String(picked.detail['leaseId']),
    fence: Number(picked.detail['fence']),
    pickup: String(picked.detail['credential']),
  };
  const outcome = await captureUnder(job, taskId, lease).catch(() => 'CAPTURE_FAULT');
  if (outcome !== 'LEASE_LOST') {
    const { leaseId, fence, pickup } = lease;
    const done = outcome === 'landed' ? 'completed' : 'failed';
    const body = { leaseId, fence, outcome: done, report: { capture: outcome } };
    // A hand-back that never answered leaves the lease to lapse.
    await call('task.handback', body, pickup).catch(() => null);
  }
  return { taskId, outcome };
}

/** The capture part of a pass: at most `CAPTURES_A_PASS` queued capture steps, in queue order. */
export const reviewCaptures = (job: CaptureJob) => async (): Promise<readonly Captured[]> => {
  const steps = (await queueOf(job.call))
    .filter((work) => work['purpose'] === CAPTURE_PURPOSE)
    .slice(0, CAPTURES_A_PASS);
  const captured: Captured[] = [];
  for (const entry of steps) {
    // oxlint-disable-next-line no-await-in-loop -- one capture at a time
    const step = await captureStep(job, entry);
    if (step !== undefined) captured.push(step);
  }
  return captured;
};
