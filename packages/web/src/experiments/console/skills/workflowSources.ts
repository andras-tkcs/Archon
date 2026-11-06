import { requestJson } from '../lib/http';
import type { components } from '@/lib/api.generated';

/**
 * A project's extra workflow sources: git refs of its own repository whose workflows it
 * loads (`extraWorkflowSources` in `.archon/config.yaml`). Nothing syncs on its own;
 * `syncExtraSources` is the one action that fetches the refs.
 */

export type ExtraSourceStatus = components['schemas']['ExtraWorkflowSourceStatus'];

type ExtraSourcesResponse = components['schemas']['ExtraWorkflowSourcesResponse'];

/** What one sync did to every configured source; `ok` is false when one failed. */
export type ExtraSourcesSyncReport = components['schemas']['ExtraWorkflowSourcesSyncResponse'];

export async function listExtraSources(projectId: string): Promise<ExtraSourceStatus[]> {
  const res = await requestJson<ExtraSourcesResponse>(
    `/api/codebases/${encodeURIComponent(projectId)}/extra-sources`
  );
  return res.sources;
}

export async function syncExtraSources(projectId: string): Promise<ExtraSourcesSyncReport> {
  return requestJson<ExtraSourcesSyncReport>(
    `/api/codebases/${encodeURIComponent(projectId)}/sync`,
    { method: 'POST' }
  );
}
