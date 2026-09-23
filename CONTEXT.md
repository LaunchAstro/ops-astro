# Domain vocabulary

The domain language for organisational records, human work, and agent execution.
Core identifiers use these terms. Presets may use audience-specific labels.

## Identity and scope

**Business**: The organisation an installation serves and the top-level boundary of its records and authority.
_Avoid_: workspace, tenant, org, account.

**Party**: An organisation the business deals with, such as a customer or supplier. A party does not replace a person's enduring identity.
_Avoid_: client, company, contact.

**Person**: One enduring human identity within a business, with linked relationships and history across changing roles. A person may exist before a login and remains when that login is removed.
_Avoid_: user, profile, login.

**Login**: A person's means of authenticating. A login's lifecycle is separate from the person's business history.
_Avoid_: person, actor.

**Actor**: A person, agent or worker that can act within a business. Authentication identifies the caller; it does not define their authority.
_Avoid_: user, profile.

**Membership**: A person's relationship and configured responsibilities within a business, party, or bounded collection of work.
_Avoid_: seat.

## Permission and review

**Grant**: A permission, held by a person, group or actor, for named actions on bounded resources, with any applicable duration and limits.
_Avoid_: clearance, login.

**Clearance**: The autonomy category that governs the review required for an action. It does not replace resource access or create a route around permission checks.
_Avoid_: trust score, global permission level.

**Gate definition**: A rule requiring a decision or precondition before a named action proceeds.
_Avoid_: approval card.

**Gate instance**: One occurrence of a gate definition against a particular proposed action.
_Avoid_: task, assignment.

**Decision**: An authorised actor's recorded response to a gate instance, including the proposal it concerns and when it was made.
_Avoid_: task completion, assignment.

## Records

**Record type**: A kind of business object defined by a preset or a person.
_Avoid_: entity type, model.

**Record**: One instance of a record type.
_Avoid_: item, entity.

**Field def**: The typed definition of a field on a record type.
_Avoid_: attribute definition.

**Link**: A typed relationship between records.
_Avoid_: association.

**View**: A saved filter, sort, and grouping over records of a type.
_Avoid_: report definition.

**Interaction**: One entry on a record's timeline, such as a message, meeting, comment, or system event.
_Avoid_: activity.

## Human work

**Task**: A unit of human work with an assignee, stage, and due date. Its related machine work is represented by runs and steps.
_Avoid_: job, execution.

**Board**: An ordered container of tasks.
_Avoid_: workspace, project.

**Stage**: An ordered position on a board or in a workflow.
_Avoid_: section, column.

## Machine work

**Workflow**: A versioned, immutable definition of execution steps.
_Avoid_: pipeline, automation.

**Installation**: A workflow version bound to a scope with its defaults and approver.
_Avoid_: workflow instance.

**Run**: One execution of an installation against a pinned workflow version and frozen context.
_Avoid_: task, job.

**Step**: One materialised node of a run, such as an agent, action, gate, transform, or terminal.
_Avoid_: task, stage.

**Skill**: An immutable released bundle of instructions and files that a step can execute.
_Avoid_: connector, plugin.

## External services

**Connector**: A provider integration's catalogued operations, sources, and authentication shape.
_Avoid_: connection.

**Connection**: One scoped relationship to a connector, including its status and credential reference. It is not a credential value.
_Avoid_: provider, account.

**Provider**: The external service a connector uses and its authentication and pricing shape.
_Avoid_: connection.

**Custody**: The controlled home and lifecycle of a credential, referenced without exposing its value.
_Avoid_: connection.

**Channel**: A route through which a message arrives or leaves.
_Avoid_: notification.

## Knowledge and evidence

**Audit event**: One append-only record of who did what, when, and under which grant.
_Avoid_: diagnostic trace.

**Knowledge doc**: A rich knowledge page inside a document space.
_Avoid_: exported file.

**Portal view**: The projection of a product interface for one internal or external audience.
_Avoid_: permission grant.
