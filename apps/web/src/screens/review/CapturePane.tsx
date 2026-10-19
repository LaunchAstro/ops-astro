// SPDX-License-Identifier: AGPL-3.0-only
//
// One capture of a revision at one width (C35, #2105): the landed picture, read by its id
// through `review.picture`, drawn `width` wide in an SVG with each pin's spot outlined and
// numbered over it. A capture asked and not landed says so. Where the pane takes a spot (the
// revision under review), a click on the picture marks one for a new pin.

import type { MouseEvent, ReactElement } from 'react';
import { Card, Empty } from '@launchastro/ui';
import type {
  ReviewCaptureView,
  ReviewPictureResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import {
  drawnSize,
  spotAround,
  spotOf,
  type Pin,
  type Size,
  type Spot,
} from './review-geometry.ts';

export interface PaneProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly title: string;
  readonly width: number;
  readonly capture: ReviewCaptureView | undefined;
  /** The pins on this capture, each with its number in the pin list. */
  readonly pins: readonly (readonly [number, Pin])[];
  /** The spot marked for a new pin, drawn dashed. */
  readonly marked?: Spot | null;
  readonly onSpot?: (spot: Spot) => void;
}

function Outline(props: { readonly spot: Spot; readonly stroke: number; readonly dashed?: true }) {
  const { spot, stroke } = props;
  return (
    <rect
      x={spot.x}
      y={spot.y}
      width={spot.width}
      height={spot.height}
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeDasharray={props.dashed === undefined ? undefined : `${String(stroke * 3)}`}
    />
  );
}

function Drawn(props: PaneProps & { readonly body: string; readonly size: Size }): ReactElement {
  const { size } = props;
  const stroke = Math.max(2, Math.round(size.width / 370));
  const onSpot = props.onSpot;
  const mark =
    onSpot === undefined
      ? undefined
      : (event: MouseEvent<SVGSVGElement>) => {
          const box = event.currentTarget.getBoundingClientRect();
          if (box.width === 0) return;
          const scale = size.width / box.width;
          const x = (event.clientX - box.left) * scale;
          const y = (event.clientY - box.top) * scale;
          onSpot(spotAround(x, y, size));
        };
  return (
    <svg
      viewBox={`0 0 ${String(size.width)} ${String(size.height)}`}
      width="100%"
      role="img"
      aria-label={`${props.title}, ${String(props.pins.length)} pinned`}
      data-capture-picture={props.width}
      onClick={mark}
    >
      <image href={`data:image/png;base64,${props.body}`} width={size.width} height={size.height} />
      {props.pins.map(([number, pin]) => {
        const spot = spotOf(pin);
        return spot === null ? null : (
          <g key={pin.commentId} data-pin-spot={number}>
            <Outline spot={spot} stroke={stroke} />
            <text
              x={spot.x}
              y={Math.max(stroke * 8, spot.y - stroke)}
              fontSize={stroke * 8}
              fill="currentColor"
            >
              {number}
            </text>
          </g>
        );
      })}
      {props.marked === undefined || props.marked === null ? null : (
        <g data-pin-marked>
          <Outline spot={props.marked} stroke={stroke} dashed />
        </g>
      )}
    </svg>
  );
}

function Landed(props: PaneProps & { readonly pictureId: string }): ReactElement {
  const read = useRead<ReviewPictureResult>({
    grantKey: props.grantKey,
    run: async () =>
      await props.client.read<ReviewPictureResult>('review.picture', {
        pictureId: props.pictureId,
      }),
    deps: [props.client, props.pictureId],
  });
  return (
    <RecordState state={read.state} subject="capture" onRetry={read.reload}>
      {(answer) => {
        const size = drawnSize(answer.picture.body, props.width);
        return size === undefined ? (
          <Empty
            title="This picture cannot be drawn here"
            description="It landed, but it is not a PNG."
            look="inline"
          />
        ) : (
          <Drawn {...props} body={answer.picture.body} size={size} />
        );
      }}
    </RecordState>
  );
}

export function CapturePane(props: PaneProps): ReactElement {
  const { capture } = props;
  return (
    <Card title={props.title} sub={`${String(props.width)} wide`}>
      <div data-capture-pane={props.width}>
        {capture?.state === 'landed' && capture.pictureId !== null ? (
          <Landed {...props} pictureId={capture.pictureId} />
        ) : (
          <Empty
            title={capture === undefined ? 'No capture asked' : 'Waiting for the capture'}
            description={
              capture === undefined
                ? 'This revision was not captured at this width.'
                : 'The capture is asked; its picture has not landed yet.'
            }
            look="inline"
          />
        )}
      </div>
    </Card>
  );
}
