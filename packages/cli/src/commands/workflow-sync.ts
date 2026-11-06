import {
  syncConfiguredExtraSources,
  type ExtraSourceSyncEntry,
} from '@archon/core/workflows/extra-sources';
import { writeJsonLine, writeStderr, writeStdout } from '../utils/stdout';

export interface WorkflowSyncOptions {
  json?: boolean;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsonEntry({ source, sync }: ExtraSourceSyncEntry): Record<string, unknown> {
  const where = { ref: source.ref, path: source.path, outcome: sync.outcome };
  if (sync.outcome === 'synced') {
    const { commit, fetched, files } = sync.result;
    return { ...where, commit, fetched, files };
  }
  if (sync.outcome === 'failed') return { ...where, error: failureMessage(sync.error) };
  return where;
}

/**
 * `archon workflow sync`: refresh the snapshots of the project's `extraWorkflowSources`.
 * Runs only when asked, and a run never does it for you: a run uses the last snapshot.
 * Exits 1 when a source failed; the sources after it are reported as not attempted.
 */
export async function workflowSyncCommand(
  projectRoot: string,
  options: WorkflowSyncOptions
): Promise<number> {
  const entries = await syncConfiguredExtraSources(projectRoot);
  const ok = entries.every(entry => entry.sync.outcome === 'synced');

  if (options.json) {
    await writeJsonLine({ ok, sources: entries.map(jsonEntry) });
    return ok ? 0 : 1;
  }
  if (entries.length === 0) {
    await writeStdout('No extraWorkflowSources are configured in .archon/config.yaml.\n');
    return 0;
  }
  for (const { source, sync } of entries) {
    const where = source.path === '.' ? source.ref : `${source.ref}:${source.path}`;
    if (sync.outcome === 'synced') {
      const { commit, fetched, files } = sync.result;
      await writeStdout(
        `${where} -> ${commit.slice(0, 12)} (${fetched ? 'fetched' : 'read locally, no remote'}, ${files} files)\n`
      );
    } else if (sync.outcome === 'failed') {
      await writeStderr(`${where} FAILED: ${failureMessage(sync.error)}\n`);
    } else {
      await writeStderr(`${where} not attempted (an earlier source failed)\n`);
    }
  }
  return ok ? 0 : 1;
}
