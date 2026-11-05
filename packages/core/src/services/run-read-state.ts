/**
 * Console read state for finished runs. The database answers which runs are unread
 * candidates (`listUnreadRunGroups`, `listUnreadCandidateIds`); this module applies
 * the operator's `autoReadWorkflows` lists from global and repository config.
 */
import { createLogger } from '@archon/paths';
import {
  workflowRunStatusSchema,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@archon/workflows/schemas/workflow-run';
import { loadGlobalConfig, loadRepoConfig } from '../config/config-loader';
import { listCodebases } from '../db/codebases';
import { listUnreadRunGroups, type UnreadRunFilters } from '../db/workflow-run-read-state';
import type { DashboardRunsResult } from '../schemas/workflow-run';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  cachedLog ??= createLogger('run-read-state');
  return cachedLog;
}

export interface AutoReadRules {
  global: readonly string[];
  byCodebase: ReadonlyMap<string, readonly string[]>;
}

export interface UnreadRunSummary {
  byStatus: DashboardRunsResult['counts'];
  byCodebase: Record<string, number>;
  total: number;
}

/** An exact stored workflow name, or a prefix when the pattern ends in `*`. */
export function matchesWorkflowPattern(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/**
 * Global entries plus each registered repository's entries. A repository whose
 * config cannot be loaded contributes nothing: its runs can then only show as
 * unread when they would otherwise be auto-read, which hides nothing.
 */
export async function loadAutoReadRules(): Promise<AutoReadRules> {
  const global = (await loadGlobalConfig()).autoReadWorkflows ?? [];
  const byCodebase = new Map<string, readonly string[]>();
  for (const codebase of await listCodebases()) {
    try {
      const entries = (await loadRepoConfig(codebase.default_cwd)).autoReadWorkflows;
      if (entries?.length) byCodebase.set(codebase.id, entries);
    } catch (error) {
      getLog().warn(
        { codebaseId: codebase.id, errorType: error instanceof Error ? error.name : typeof error },
        'run_read_state.repo_config_unreadable'
      );
    }
  }
  return { global, byCodebase };
}

export function isAutoRead(
  rules: AutoReadRules,
  codebaseId: string | null,
  workflowName: string
): boolean {
  const repo = codebaseId === null ? [] : (rules.byCodebase.get(codebaseId) ?? []);
  return [...rules.global, ...repo].some(pattern => matchesWorkflowPattern(pattern, workflowName));
}

export async function summarizeUnreadRuns(
  filters: UnreadRunFilters,
  rules: AutoReadRules
): Promise<UnreadRunSummary> {
  const byStatus = {
    all: 0,
    ...(Object.fromEntries(workflowRunStatusSchema.options.map(status => [status, 0])) as Record<
      WorkflowRunStatus,
      number
    >),
  };
  const byCodebase: Record<string, number> = {};
  for (const group of await listUnreadRunGroups(filters)) {
    if (isAutoRead(rules, group.codebase_id, group.workflow_name)) continue;
    byStatus.all += group.count;
    byStatus[group.status] += group.count;
    if (group.codebase_id !== null) {
      byCodebase[group.codebase_id] = (byCodebase[group.codebase_id] ?? 0) + group.count;
    }
  }
  return { byStatus, byCodebase, total: byStatus.all };
}

/** Ids of `runs` that are unread: the database's candidates minus the auto-read list. */
export function unreadRunIdsOf(
  runs: readonly Pick<WorkflowRun, 'id' | 'codebase_id' | 'workflow_name'>[],
  candidates: ReadonlySet<string>,
  rules: AutoReadRules
): string[] {
  return runs
    .filter(run => candidates.has(run.id) && !isAutoRead(rules, run.codebase_id, run.workflow_name))
    .map(run => run.id);
}
