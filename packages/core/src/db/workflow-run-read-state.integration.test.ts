// @archon-test-isolated
/**
 * Integration test: console read state against a REAL bun:sqlite database. The
 * unread rule is SQL over stored rows (parent, resource start, terminal status,
 * read_at against completed_at), so only a real adapter can prove it.
 *
 * Runs in its own `bun test` invocation (declared by @archon-test-isolated) — it
 * mock.module's ./connection with a real adapter.
 */
import { describe, test, expect, mock } from 'bun:test';

const realPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realPaths,
  createLogger: () => ({
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  }),
}));

const realConnection = { ...(await import('./connection')) };
const { SqliteAdapter, sqliteDialect } = await import('./adapters/sqlite');
const db = new SqliteAdapter(':memory:');

mock.module('./connection', () => ({
  ...realConnection,
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { getWorkflowRun } = await import('./workflows');
const { listUnreadCandidateIds, listUnreadRunGroups, markWorkflowRunRead } = await import(
  './workflow-run-read-state'
);
const { summarizeUnreadRuns } = await import('../services/run-read-state');

await db.query(
  `INSERT INTO remote_agent_codebases (id, name, default_cwd, kind)
   VALUES ('cb-1', 'ops-client', '/tmp/ops-client', 'repo')`,
  []
);
await db.query(
  `INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id)
   VALUES ('conv-1', 'web', 'conv-1-platform')`,
  []
);

async function insertRun(
  id: string,
  fields: {
    status: string;
    workflow?: string;
    parent?: string;
    metadata?: Record<string, unknown>;
    completedAt?: string | null;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO remote_agent_workflow_runs
       (id, workflow_name, conversation_id, codebase_id, user_message, status, metadata,
        parent_run_id, completed_at)
     VALUES ($1, $2, 'conv-1', 'cb-1', '', $3, $4, $5, $6)`,
    [
      id,
      fields.workflow ?? 'implement',
      fields.status,
      JSON.stringify(fields.metadata ?? {}),
      fields.parent ?? null,
      fields.completedAt === undefined ? '2026-08-27 07:20:00' : fields.completedAt,
    ]
  );
}

await insertRun('top', { status: 'completed' });
await insertRun('failed', { status: 'failed', workflow: 'review' });
await insertRun('child', { status: 'completed', parent: 'top' });
await insertRun('triggered', {
  status: 'failed',
  metadata: { resource_start: { receiptId: 'rcpt-1', bindingId: 'bind-1' } },
});
await insertRun('running', { status: 'running', completedAt: null });

const ALL_IDS = ['top', 'failed', 'child', 'triggered', 'running'];
const NO_RULES = { global: [], byCodebase: new Map() };

describe('console read state', () => {
  test('only terminal, top-level, human-started runs are unread candidates', async () => {
    expect([...(await listUnreadCandidateIds(ALL_IDS))].sort()).toEqual(['failed', 'top']);
    expect(await listUnreadCandidateIds([])).toEqual(new Set());
  });

  test('groups candidates by codebase, workflow and status', async () => {
    const groups = await listUnreadRunGroups({});
    expect(groups.sort((a, b) => a.workflow_name.localeCompare(b.workflow_name))).toEqual([
      { codebase_id: 'cb-1', workflow_name: 'implement', status: 'completed', count: 1 },
      { codebase_id: 'cb-1', workflow_name: 'review', status: 'failed', count: 1 },
    ]);
  });

  test('the auto-read list removes matching runs from the summary', async () => {
    expect((await summarizeUnreadRuns({}, NO_RULES)).byStatus).toMatchObject({
      all: 2,
      completed: 1,
      failed: 1,
      running: 0,
    });
    const summary = await summarizeUnreadRuns(
      {},
      { global: [], byCodebase: new Map([['cb-1', ['rev*']]]) }
    );
    expect(summary.byStatus).toMatchObject({ all: 1, completed: 1, failed: 0 });
    expect(summary.byCodebase).toEqual({ 'cb-1': 1 });
    expect(summary.total).toBe(1);
  });

  test('marking read hides the run until a later completion', async () => {
    expect(await markWorkflowRunRead('top')).toBe(true);
    expect(await listUnreadCandidateIds(['top'])).toEqual(new Set());

    // A resume clears completed_at; the next terminal transition writes a later one.
    await db.query(
      "UPDATE remote_agent_workflow_runs SET completed_at = datetime('now', '+1 minute') WHERE id = 'top'",
      []
    );
    expect(await listUnreadCandidateIds(['top'])).toEqual(new Set(['top']));
  });

  test('marking an unknown run reports no row', async () => {
    expect(await markWorkflowRunRead('missing')).toBe(false);
  });

  test('read_at never reaches the run object', async () => {
    await markWorkflowRunRead('failed');
    const run = await getWorkflowRun('failed');
    expect(run).not.toBeNull();
    expect(Object.keys(run ?? {})).not.toContain('read_at');
  });
});
