// SPDX-License-Identifier: AGPL-3.0-only
//
// The review pages' screens, spread into `SCREENS` (`screen-registry.tsx`): Projects > Reviews
// (#2157), the Review workspace (#2105) and the client's own reviews in the portal.

import type { ReactElement } from 'react';
import { tabRollupFloor } from '../../data/rollup-floor.ts';
import type { ScreenContext } from '../../screen-registry.tsx';
import { ClientReviewsScreen } from './ClientReviews.tsx';
import { ReviewsScreen } from './Reviews.tsx';
import { ReviewWorkspaceScreen } from './ReviewWorkspace.tsx';

type ReviewRoute = 'agency:reviews' | 'agency:review-workspace' | 'portal:reviews';

export const REVIEW_SCREENS: {
  readonly [Id in ReviewRoute]: (context: ScreenContext<Id>) => ReactElement;
} = {
  'agency:reviews': (context) => (
    <ReviewsScreen client={context.client} grantKey={context.grantKey} rollup={tabRollupFloor()} />
  ),
  // Keyed on the grant and the review, so a change of business, person or review starts the
  // marked spot and an unsent pin over.
  'agency:review-workspace': (context) => (
    <ReviewWorkspaceScreen
      key={`${context.grantKey}:${context.params.review}`}
      client={context.client}
      grantKey={context.grantKey}
      reviewId={context.params.review}
      rollup={tabRollupFloor()}
      navigate={context.navigate}
      {...(context.taskPanel === undefined ? {} : { taskPanel: context.taskPanel })}
    />
  ),
  'portal:reviews': (c) => <ClientReviewsScreen client={c.client} grantKey={c.grantKey} />,
};
