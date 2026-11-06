import {
  readExtraSourceSnapshot,
  syncExtraSource,
  type ExtraSourceSnapshotMeta,
  type ExtraSourceSyncResult,
} from '@archon/workflows/extra-sources';
import type { ExtraWorkflowSource } from '@archon/workflows/schemas/run-metadata';
import { loadConfig } from '../config/config-loader';

/** One configured extra workflow source and what was last synced for it. */
export interface ExtraSourceStatus {
  source: ExtraWorkflowSource;
  /** Null when the source has never been synced. */
  snapshot: ExtraSourceSnapshotMeta | null;
}

/** What one sync did to one configured source. */
export type ExtraSourceSyncOutcome =
  | { outcome: 'synced'; result: ExtraSourceSyncResult }
  | { outcome: 'failed'; error: unknown }
  | { outcome: 'not_attempted' };

/** A configured source, its snapshot as the sync left it, and what the sync did to it. */
export interface ExtraSourceSyncEntry extends ExtraSourceStatus {
  sync: ExtraSourceSyncOutcome;
}

async function withSnapshots<T extends { source: ExtraWorkflowSource }>(
  projectRoot: string,
  items: readonly T[]
): Promise<(T & Pick<ExtraSourceStatus, 'snapshot'>)[]> {
  const statuses: (T & Pick<ExtraSourceStatus, 'snapshot'>)[] = [];
  for (const item of items) {
    const snapshot = await readExtraSourceSnapshot(projectRoot, item.source);
    statuses.push({ ...item, snapshot: snapshot?.meta ?? null });
  }
  return statuses;
}

/** The project's `extraWorkflowSources` with the snapshot each one currently has. */
export async function listExtraSources(projectRoot: string): Promise<ExtraSourceStatus[]> {
  const config = await loadConfig(projectRoot);
  return withSnapshots(
    projectRoot,
    (config.extraWorkflowSources ?? []).map(source => ({ source }))
  );
}

/**
 * Refresh every configured extra workflow source, in config order. The first failure
 * stops the sync: sources before it keep their new snapshots, it and the sources after it
 * keep their previous ones. Every configured source is reported, so the caller can say
 * which were synced, which failed and which were never attempted. Only a config that
 * cannot be loaded throws, because then there are no sources to report.
 */
export async function syncConfiguredExtraSources(
  projectRoot: string
): Promise<ExtraSourceSyncEntry[]> {
  const config = await loadConfig(projectRoot);
  const outcomes: { source: ExtraWorkflowSource; sync: ExtraSourceSyncOutcome }[] = [];
  let failed = false;
  for (const source of config.extraWorkflowSources ?? []) {
    if (failed) {
      outcomes.push({ source, sync: { outcome: 'not_attempted' } });
      continue;
    }
    try {
      const result = await syncExtraSource(projectRoot, source, config.remote);
      outcomes.push({ source, sync: { outcome: 'synced', result } });
    } catch (error) {
      failed = true;
      outcomes.push({ source, sync: { outcome: 'failed', error } });
    }
  }
  return withSnapshots(projectRoot, outcomes);
}
