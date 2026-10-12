// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactElement, ReactNode } from 'react';
import { Chip } from '../kit/marks.tsx';
import { Icon } from '../primitives/Icon.tsx';

export interface ReviewCardProps {
  readonly title: string;
  readonly lead: ReactNode;
  readonly figures: string;
  readonly shows: ReactNode;
  readonly action: ReactNode;
  readonly needs: ReactNode;
  readonly skills: readonly string[];
  readonly onReview: (() => void) | undefined;
  readonly onDiscuss: () => void;
  readonly onPlan: () => void;
}

export function ReviewCard(props: ReviewCardProps): ReactElement {
  return (
    <article className="rq__item" aria-label={props.title}>
      <div className="rq__lead">
        {props.lead}
        {props.figures === '' ? null : <span className="rq__figs">{props.figures}</span>}
      </div>
      <div className="rec">
        <h2 className="rec__title">{props.title}</h2>
        <div className="rec__grid">
          <ReviewColumn label="What the data shows">{props.shows}</ReviewColumn>
          <ReviewColumn label="What we’ll do">{props.action}</ReviewColumn>
          <ReviewColumn label="What it needs from you">{props.needs}</ReviewColumn>
        </div>
        <div className="rec__respond">
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={props.onReview === undefined}
            onClick={props.onReview}
            title="Review the exact version before approving"
          >
            Good to go
          </button>
          <button type="button" className="btn btn--sm btn--secondary" onClick={props.onDiscuss}>
            Let’s discuss
          </button>
          <button type="button" className="btn btn--sm btn--secondary" onClick={props.onPlan}>
            View plan <Icon name="list-check" size="xs" />
          </button>
          {props.skills.length === 0 ? null : (
            <span className="rq__skills">
              <span className="rec__label">Skills</span>
              {props.skills.map((skill) => (
                <Chip key={skill}>
                  {skill}
                  <Icon name="document" size="xs" />
                </Chip>
              ))}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function ReviewColumn(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <div className="rec__label">{props.label}</div>
      <div className="rec__text">{props.children}</div>
    </div>
  );
}
