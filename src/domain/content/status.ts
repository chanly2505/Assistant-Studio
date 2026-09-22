/**
 * The project status workflow.
 * docs/architecture/03-database-architecture.md, Content
 *
 * Creators do not work in a straight line: a short skips filming, an edit
 * goes back to scripting. So any active status may move to any other, and
 * every move is recorded as a ContentStatusEvent — the history is the source
 * of truth, not the rule. Only two moves carry a precondition:
 *
 *   → SCHEDULED   needs a scheduled date, or there is nothing to schedule
 *   → PUBLISHED   stamps publishedAt; leaving PUBLISHED clears it
 *
 * ARCHIVED hides a project from the board without deleting it; restoring
 * returns it to any active status (the UI offers the one it had before).
 */

export const PROJECT_STATUSES = [
  'IDEA',
  'SCRIPTING',
  'FILMING',
  'EDITING',
  'SCHEDULED',
  'PUBLISHED',
  'ARCHIVED',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Board columns, in working order. ARCHIVED is not a column. */
export const BOARD_STATUSES = PROJECT_STATUSES.filter(
  (status): status is Exclude<ProjectStatus, 'ARCHIVED'> => status !== 'ARCHIVED',
);

export type TransitionProblem = 'SAME_STATUS' | 'NEEDS_SCHEDULE_DATE';

export function checkTransition(
  from: ProjectStatus,
  to: ProjectStatus,
  project: { scheduledFor: Date | null },
): TransitionProblem | null {
  if (from === to) return 'SAME_STATUS';
  if (to === 'SCHEDULED' && !project.scheduledFor) return 'NEEDS_SCHEDULE_DATE';
  return null;
}

/** What else changes on the project when it moves `to` a status. */
export function transitionEffects(
  from: ProjectStatus,
  to: ProjectStatus,
  now: Date,
): { publishedAt?: Date | null } {
  if (to === 'PUBLISHED') return { publishedAt: now };
  if (from === 'PUBLISHED') return { publishedAt: null };
  return {};
}

/** The next column on the board, for a one-click "move on" button. */
export function nextStatus(status: ProjectStatus): ProjectStatus | null {
  const index = BOARD_STATUSES.indexOf(status as (typeof BOARD_STATUSES)[number]);
  if (index < 0 || index === BOARD_STATUSES.length - 1) return null;
  return BOARD_STATUSES[index + 1] ?? null;
}
