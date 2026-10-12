// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactElement } from 'react';
import { Icon, TabPanel, usePageToolbar } from '@launchastro/ui';
import { createPortal } from 'react-dom';
import { ProjectBoard, type ProjectsProps } from './projects/ProjectBoard.tsx';
import { WorkLog } from './projects/WorkLog.tsx';
import { ProjectsTabs } from './projects/ProjectsTabs.tsx';
import { ProjectsToolbar } from './projects/ProjectsToolbar.tsx';
import { TABS, useProjectsTab } from './projects/tab-address.ts';
import { useProjectBoardAddress } from './projects/board-address.ts';
import { NO_DOOR, type BoardDoor } from './projects/project-client.ts';

export type { ProjectsProps };

export function Projects(props: ProjectsProps): ReactElement {
  const { canFileTask = false, inPanel } = props;
  const toolbar = usePageToolbar();
  const { tab, select, workLogOpened } = useProjectsTab(props.address, inPanel === true);
  // The board's place, held here so the toolbar's door carries the view the board is on.
  const place = useProjectBoardAddress(props.address, inPanel === true, tab !== 'board');
  // What the board's doors file, given only by the board read for this reader and place.
  const doorOf = `${props.grantKey}:${place.query}:${String(place.generation)}`;
  const [answered, onDoor] = useState<BoardDoor>(NO_DOOR);
  const door = answered.of === doorOf ? answered : NO_DOOR;
  return (
    <div className="stack projects">
      {tab === 'board' ? (
        <ProjectsToolbar
          inPanel={inPanel === true}
          canFileTask={canFileTask}
          address={place.view}
          clients={door.clients}
          project={door.project}
        />
      ) : null}
      <ViewSwitch tab={tab} select={select} toolbar={inPanel === true ? null : toolbar} />
      <TabPanel name="projects" tab="board" selected={tab}>
        <ProjectBoard
          canFileTask={canFileTask}
          hidden={tab !== 'board'}
          place={place}
          doorOf={doorOf}
          onDoor={onDoor}
          client={props.client}
          grantKey={props.grantKey}
          {...(props.taskPanel === undefined ? {} : { taskPanel: props.taskPanel })}
          {...(props.address === undefined ? {} : { address: props.address })}
          inPanel={props.inPanel === true}
        />
      </TabPanel>
      <TabPanel name="projects" tab="worklog" selected={tab}>
        {workLogOpened ? (
          <WorkLog client={props.client} grantKey={props.grantKey} navigate={props.navigate} />
        ) : null}
      </TabPanel>
    </div>
  );
}

/** The view switch: a menu in the page toolbar when the page has one, else the page's own tabs. */
function ViewSwitch(props: {
  readonly tab: ReturnType<typeof useProjectsTab>['tab'];
  readonly select: ReturnType<typeof useProjectsTab>['select'];
  readonly toolbar: HTMLElement | null;
}): ReactElement {
  const { tab, select, toolbar } = props;
  return toolbar === null ? (
    <ProjectsTabs label="Projects" name="projects" tabs={TABS} selected={tab} onSelect={select} />
  ) : (
    createPortal(<ProjectViews tab={tab} select={select} />, toolbar)
  );
}

function ProjectViews(props: {
  readonly tab: ReturnType<typeof useProjectsTab>['tab'];
  readonly select: ReturnType<typeof useProjectsTab>['select'];
}): ReactElement {
  const { tab, select } = props;
  return (
    <details className="projects__views">
      <summary aria-label="Project views" title="Project views">
        <Icon name="calendar" size="xs" />
      </summary>
      <ProjectsTabs label="Projects" name="projects" tabs={TABS} selected={tab} onSelect={select} />
    </details>
  );
}
