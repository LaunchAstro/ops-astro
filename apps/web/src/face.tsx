// SPDX-License-Identifier: AGPL-3.0-only
//
// Which face a page is drawn for (MP-2-4). On the client face an agency
// member sees a labelled "view as client" preview: copy speaks to the client
// in the second person, channel links print as plain text, and no client
// write is offered. Surfaces read the face from here rather than hiding parts
// of themselves after drawing them.

import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

export interface FaceState {
  readonly face: 'agency' | 'client';
  /** The client face, seen by an agency member: always a preview until MP-11-1's portal login. */
  readonly preview: boolean;
  /** Whether a surface may offer a write. */
  readonly writes: boolean;
}

const AGENCY: FaceState = { face: 'agency', preview: false, writes: true };
const CLIENT: FaceState = { face: 'client', preview: true, writes: false };

const FaceContext = createContext<FaceState>(AGENCY);

export function FaceProvider(props: {
  readonly face: FaceState['face'];
  readonly children: ReactNode;
}): ReactElement {
  return (
    <FaceContext.Provider value={props.face === 'client' ? CLIENT : AGENCY}>
      {props.children}
    </FaceContext.Provider>
  );
}

export const useFace = (): FaceState => useContext(FaceContext);

/** Third person to the agency, second person to the client. */
export function Voice(props: { readonly agency: string; readonly client: string }): ReactElement {
  return <>{useFace().face === 'client' ? props.client : props.agency}</>;
}

/** A link into a channel's own tool: a link for the agency, plain words for the client. */
export function ChannelLink(props: {
  readonly href: string;
  readonly children: ReactNode;
}): ReactElement {
  if (useFace().face === 'client') return <span className="channel">{props.children}</span>;
  return (
    <a className="channel" href={props.href} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  );
}
