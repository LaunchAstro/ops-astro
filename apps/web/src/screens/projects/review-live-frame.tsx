// SPDX-License-Identifier: AGPL-3.0-only
//
// C35-X, LF-2: the live view beside a review's capture. The bound page is
// framed directly, hidden until its embed says hello for this load, and
// hidden again to wait for a new hello whenever the frame loads another page; with no
// hello in time, or no address fit to frame, the frame is removed and the
// capture stands with the line and a link to the staged page. The capture
// stays the evidence: the live view stores nothing and nothing binds to it.
// The review workspace (#2105) places it; it reads no record of its own.

import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { Empty } from '@launchastro/ui';
import { awaitHello, freshNonce, liveFrameAddress } from './review-live-hello.ts';

/** Scripts and the site's own origin only: no top navigation, popups or downloads. */
export const LIVE_FRAME_SANDBOX = 'allow-scripts allow-same-origin';

/** No camera, microphone, location or payment for the framed page. */
export const LIVE_FRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'";

export const LIVE_FALLBACK_LINE = "Live view isn't set up for this site";

type Phase = 'waiting' | 'live' | 'fallback';

/** This load's phase: waiting until the frame's hello or the timeout settles it. */
function useLivePhase(
  frame: RefObject<HTMLIFrameElement | null>,
  address: URL | undefined,
  load: string,
): Phase {
  const [settled, setSettled] = useState<{ readonly at: string; readonly phase: Phase }>();
  // Each load (a new serial, so switching back never revives an old hello) and
  // each page the frame shows after a hello (`times`) is its own wait.
  const [round, setRound] = useState({ load, serial: 0, times: 0 });
  if (round.load !== load) setRound({ load, serial: round.serial + 1, times: 0 });
  const { serial, times } = round.load === load ? round : { serial: round.serial + 1, times: 0 };
  const at = `${serial}\n${times}`;
  useEffect(() => {
    const element = frame.current;
    if (address === undefined || element === null) return () => {};
    return awaitHello({
      frame: element,
      siteOrigin: address.origin,
      nonce: freshNonce(),
      loaded: times > 0,
      onLive: () => setSettled({ at, phase: 'live' }),
      onExpired: () => setSettled({ at, phase: 'fallback' }),
      onLeft: () =>
        setRound((now) => (now.serial === serial ? { ...now, times: now.times + 1 } : now)),
    });
    // The wait restarts only for a new load or page; `address` is read from `load`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  if (address === undefined) return 'fallback';
  return settled?.at === at ? settled.phase : 'waiting';
}

function Fallback(props: { readonly address: URL | undefined }): ReactElement {
  return (
    <div data-live-fallback="">
      <p>{LIVE_FALLBACK_LINE}</p>
      {props.address === undefined ? null : (
        <a href={props.address.href} target="_blank" rel="noopener noreferrer" data-staged-page="">
          Open the staged page
        </a>
      )}
    </div>
  );
}

export function LiveFrame(props: {
  /** The review's bound page. */
  readonly pageUrl: string;
  /** The load this frame belongs to (the revision under review); a change is a new load. */
  readonly loadKey: string;
  /** The capture at this width, or null when there is none to show. */
  readonly capture: ReactNode | null;
}): ReactElement {
  const address = liveFrameAddress(props.pageUrl, window.location.origin);
  const load = `${props.loadKey}\n${address?.href ?? ''}`;
  const frame = useRef<HTMLIFrameElement>(null);
  const phase = useLivePhase(frame, address, load);
  return (
    <div className="review-live" data-live-view={phase}>
      <div data-live-capture="">{props.capture ?? <Empty title="No capture yet" />}</div>
      {phase === 'fallback' ? (
        <Fallback address={address} />
      ) : (
        <iframe
          key={load}
          ref={frame}
          title="Live view"
          data-live-frame=""
          src={address?.href}
          sandbox={LIVE_FRAME_SANDBOX}
          allow={LIVE_FRAME_ALLOW}
          referrerPolicy="no-referrer"
          hidden={phase === 'waiting'}
        />
      )}
    </div>
  );
}
