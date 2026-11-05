import { requestJson } from '../lib/http';
import { toRun, type Run } from '../primitives/run';
import { toRunEvent, type RunEvent, type RunNodeState } from '../primitives/event';
import type { RunStatus } from '../lib/run-status';
import type { components } from '@/lib/api.generated';

export interface ListRunsOptions {
  codebaseId?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

type DashboardRunsResponse = components['schemas']['DashboardRunsResponse'];
export type RunCounts = DashboardRunsResponse['counts'];
type RunDetailResponse = components['schemas']['WorkflowRunDetail'];

function normalizeCounts(c: Partial<RunCounts>): RunCounts {
  return {
    all: c.all ?? 0,
    running: c.running ?? 0,
    paused: c.paused ?? 0,
    failed: c.failed ?? 0,
    completed: c.completed ?? 0,
    cancelled: c.cancelled ?? 0,
    pending: c.pending ?? 0,
  };
}

export interface RunFeed {
  runs: Run[];
  counts: RunCounts;
  /** Unread finished runs per bucket, under the same filters as `counts`. */
  unread: RunCounts;
  total: number;
}

export async function listRuns(opts: ListRunsOptions = {}): Promise<RunFeed> {
  const qs = new URLSearchParams();
  if (opts.codebaseId !== undefined) qs.set('codebaseId', opts.codebaseId);
  if (opts.status !== undefined) qs.set('status', opts.status);
  if (opts.limit !== undefined) qs.set('limit', opts.limit.toString());
  if (opts.offset !== undefined) qs.set('offset', opts.offset.toString());
  const url = `/api/dashboard/runs${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  const res = await requestJson<DashboardRunsResponse>(url);
  const unreadIds = new Set(res.unreadRunIds);
  return {
    runs: res.runs.map(raw => ({ ...toRun(raw), unread: unreadIds.has(raw.id) })),
    counts: normalizeCounts(res.counts),
    unread: normalizeCounts(res.unread),
    total: res.total,
  };
}

type AttentionResponse = components['schemas']['RunsNeedingAttentionResponse'];
export interface RunsAttention {
  runs: Run[];
  degraded: NonNullable<AttentionResponse['degraded']>;
}

export async function listRunsNeedingAttention(): Promise<RunsAttention> {
  const res =
    await requestJson<components['schemas']['RunsNeedingAttentionResponse']>('/api/runs/attention');
  return { runs: res.runs.map(toRun), degraded: res.degraded ?? [] };
}

export type UnreadByProject = components['schemas']['DashboardUnreadResponse'];

/** Unread finished runs across every project, for the project rail. */
export async function listUnreadByProject(): Promise<UnreadByProject> {
  return requestJson<UnreadByProject>('/api/dashboard/unread');
}

/** Mark the run's current result read for everyone on this install. */
export async function markRunRead(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/read`, { method: 'POST' });
}

export async function getRun(
  id: string
): Promise<{ run: Run; events: RunEvent[]; nodes: RunNodeState[] }> {
  const res = await requestJson<RunDetailResponse>(`/api/workflows/runs/${encodeURIComponent(id)}`);
  return {
    run: toRun(res.run),
    events: res.events.map(toRunEvent),
    nodes: res.run.nodes,
  };
}

export async function cancelRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

type RespondWorkflowRunBody = components['schemas']['RespondWorkflowRunBody'];

export async function respondRun(
  id: string,
  decision: string,
  text?: string,
  expectedGate?: RespondWorkflowRunBody['expectedGate']
): Promise<void> {
  const body: RespondWorkflowRunBody = { decision, text, expectedGate };
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/respond`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

type AnswerWorkflowRunBody = components['schemas']['AnswerWorkflowRunBody'];

/**
 * Answer a paused attention wait in its declared form. `occurrence` is the one the run's
 * attention reports; the server refuses an answer meant for any other pause.
 */
export async function answerRun(
  id: string,
  occurrence: string,
  choose: string[],
  text?: string
): Promise<void> {
  const body: AnswerWorkflowRunBody = { occurrence, choose, text };
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function resumeRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function abandonRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/abandon`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Re-exported from the generated OpenAPI types so the console doesn't drift
 * from the server contract. Schema lives in
 * packages/server/src/routes/schemas/workflow.schemas.ts.
 */
export type ArtifactFile = components['schemas']['ArtifactFile'];
type ListArtifactsResponse = components['schemas']['ListArtifactsResponse'];

export async function listRunArtifacts(runId: string): Promise<ArtifactFile[]> {
  const res = await requestJson<ListArtifactsResponse>(
    `/api/runs/${encodeURIComponent(runId)}/artifacts`
  );
  return res.files;
}

/** Fetch a single artifact file as text (markdown or plain). */
export async function fetchArtifact(runId: string, path: string): Promise<string> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`/api/artifacts/${encodeURIComponent(runId)}/${encodedPath}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to fetch artifact: ${res.status.toString()}`);
  }
  return res.text();
}
