/**
 * Console read state for workflow runs: the `read_at` write and the unread-candidate
 * queries. Kept out of the `./workflows` entry because read state is a console
 * concern, not part of the run lifecycle; `services/run-read-state` applies the
 * operator's auto-read lists on top.
 */
import { RESOURCE_START_METADATA_KEY } from '@archon/workflows/schemas/resource-start';
import {
  TERMINAL_WORKFLOW_STATUSES,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import type { ListDashboardRunsOptions } from '../schemas/workflow-run';
import { getDatabaseType, getDialect, pool } from './connection';
import { buildDashboardWhereClauses } from './workflow-run-lists';
import { readWorkflowRunStatus } from './workflow-run-status';

/**
 * Mark a run's current result read for the whole install. False when no run has
 * this id. Idempotent; a later completion makes the run unread again.
 */
export async function markWorkflowRunRead(id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE remote_agent_workflow_runs SET read_at = ${getDialect().now()} WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Conditions every unread run meets apart from the auto-read list: a top-level,
 * human-started run (no parent, no resource start) with a terminal result nobody
 * has marked read since it completed. A run read and then resumed is unread again
 * once its new result lands, because its new `completed_at` is later.
 */
function unreadCandidateClause(values: unknown[]): string {
  const statuses = TERMINAL_WORKFLOW_STATUSES.map(status => {
    values.push(status);
    return `$${String(values.length)}`;
  });
  const receipt = getDialect().jsonText('r.metadata', `${RESOURCE_START_METADATA_KEY}.receiptId`);
  return `(r.parent_run_id IS NULL
    AND ${receipt} IS NULL
    AND r.status IN (${statuses.join(', ')})
    AND (r.read_at IS NULL OR (r.completed_at IS NOT NULL AND r.read_at < r.completed_at)))`;
}

export type UnreadRunFilters = Pick<
  ListDashboardRunsOptions,
  'codebaseId' | 'search' | 'after' | 'before'
>;

export interface UnreadRunGroup {
  codebase_id: string | null;
  workflow_name: string;
  status: WorkflowRunStatus;
  count: number;
}

/**
 * Unread candidates (see `unreadCandidateClause`) grouped by codebase, workflow and
 * status, under the dashboard's filters. The caller applies the auto-read list.
 */
export async function listUnreadRunGroups(filters: UnreadRunFilters): Promise<UnreadRunGroup[]> {
  const values: unknown[] = [];
  const clauses = [...buildDashboardWhereClauses(filters, values), unreadCandidateClause(values)];
  const result = await pool.query<{
    id: string;
    codebase_id: string | null;
    workflow_name: string;
    status: string;
    cnt: number | string;
  }>(
    `SELECT MIN(CAST(r.id AS TEXT)) AS id, r.codebase_id, r.workflow_name, r.status, COUNT(*) AS cnt
     FROM remote_agent_workflow_runs r
     WHERE ${clauses.join(' AND ')}
     GROUP BY r.codebase_id, r.workflow_name, r.status`,
    values
  );
  return result.rows.map(row => ({
    codebase_id: row.codebase_id,
    workflow_name: row.workflow_name,
    status: readWorkflowRunStatus(row.id, row.status),
    count: Number(row.cnt),
  }));
}

/** The subset of `runIds` that are unread candidates (see `unreadCandidateClause`). */
export async function listUnreadCandidateIds(runIds: readonly string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const values: unknown[] = [JSON.stringify(runIds)];
  const ids =
    getDatabaseType() === 'postgresql'
      ? 'SELECT value::uuid FROM json_array_elements_text($1::json) AS ids(value)'
      : 'SELECT value FROM json_each($1)';
  const result = await pool.query<{ id: string }>(
    `SELECT r.id FROM remote_agent_workflow_runs r
     WHERE r.id IN (${ids}) AND ${unreadCandidateClause(values)}`,
    values
  );
  return new Set(result.rows.map(row => row.id));
}
