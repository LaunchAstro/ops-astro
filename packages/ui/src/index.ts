// SPDX-License-Identifier: AGPL-3.0-only
//
// The shared interface package's one entry point, and the surface a code-side
// discovery check reads.
//
// It is `export *` per module rather than a hand-written list, so a component
// added to a module below appears here without anybody remembering to add it —
// which is the whole reason the capability map's missing-registration check can
// be trusted in the code-to-map direction.
//
// **The naming rule this package lives under, because the check depends on it:
// an export in PascalCase is a UI component and must carry a capability-map
// entry; everything else is camelCase or UPPER_CASE and must not.** It is a
// convention, and it is checkable from the built artefact, which is more than
// can be said for a comment asserting the same thing.
//
// This package imports no `core-*` package and must not. It owns visual
// controls and layout; session-scoped panel registration, open state and drafts
// belong to `apps/web` [ui-reference CONTRACT.md:305].
//
// **The working slice exports only what its screens mount.** There is no
// `AgentTab`, `AgentPanel` or `Gate`: each draws a surface the slice's three
// screens do not reach, over records no part of this build stores, and an
// exported component that nothing mounts is an estate to maintain, not a
// capability. They arrive with the phase that owns them.

// The package's stylesheets, in their load order: tokens, then primitives, then
// the shell, then the board, then the task surfaces. They enter through this
// file like everything else in the package, and `apps/web/src/main.tsx` imports
// the package before its own sheet, so the order holds in the bundle.
import './styles/1-tokens.css';
import './styles/2-primitives.css';
import './styles/3-shell.css';
import './styles/4-board.css';
import './styles/4b-board-machine.css';
import './styles/5-task.css';

export * from './state/corpus.ts';
export * from './state/project.ts';
export * from './primitives/Absence.tsx';
export * from './primitives/Status.tsx';
export * from './primitives/Tabs.tsx';
export * from './surfaces/Shell.tsx';
export * from './surfaces/Board.tsx';
export * from './surfaces/BoardMachine.tsx';
export * from './surfaces/ProjectsBoard.tsx';
export * from './board/index.ts';
export * from './surfaces/TaskPage.tsx';
