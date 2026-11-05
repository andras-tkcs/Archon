// @archon-test-isolated
import { describe, test, expect, mock } from 'bun:test';
import type { GlobalConfig, RepoConfig } from '../config/config-types';

const realConfigLoader = { ...(await import('../config/config-loader')) };
const realCodebases = { ...(await import('../db/codebases')) };
const repoConfigs = new Map<string, RepoConfig | Error>();
let globalConfig: GlobalConfig = {};

mock.module('../config/config-loader', () => ({
  ...realConfigLoader,
  loadGlobalConfig: async () => globalConfig,
  loadRepoConfig: async (path: string) => {
    const config = repoConfigs.get(path) ?? {};
    if (config instanceof Error) throw config;
    return config;
  },
}));
mock.module('../db/codebases', () => ({
  ...realCodebases,
  listCodebases: async () => [
    { id: 'cb-a', default_cwd: '/repo/a' },
    { id: 'cb-b', default_cwd: '/repo/b' },
    { id: 'cb-broken', default_cwd: '/repo/broken' },
  ],
}));

const { isAutoRead, loadAutoReadRules, matchesWorkflowPattern, unreadRunIdsOf } = await import(
  './run-read-state'
);

describe('matchesWorkflowPattern', () => {
  test('matches an exact name or a trailing-* prefix', () => {
    expect(matchesWorkflowPattern('archon-implement', 'archon-implement')).toBe(true);
    expect(matchesWorkflowPattern('archon-implement', 'archon-implement-x')).toBe(false);
    expect(matchesWorkflowPattern('tkcs-lab/devflow:*', 'tkcs-lab/devflow:devflow-plan')).toBe(
      true
    );
    expect(matchesWorkflowPattern('devflow-run-*', 'archon-implement')).toBe(false);
  });

  test('treats a * anywhere else as a literal character', () => {
    expect(matchesWorkflowPattern('dev*flow', 'devXflow')).toBe(false);
    expect(matchesWorkflowPattern('dev*flow', 'dev*flow')).toBe(true);
  });
});

describe('loadAutoReadRules', () => {
  test('global entries apply everywhere, repository entries only to their codebase', async () => {
    globalConfig = { autoReadWorkflows: ['nightly-*'] };
    repoConfigs.set('/repo/a', { autoReadWorkflows: ['review'] });
    repoConfigs.set('/repo/broken', new Error('bad yaml'));

    const rules = await loadAutoReadRules();

    expect(rules.global).toEqual(['nightly-*']);
    expect([...rules.byCodebase.keys()]).toEqual(['cb-a']);
    expect(isAutoRead(rules, 'cb-b', 'nightly-sweep')).toBe(true);
    expect(isAutoRead(rules, null, 'nightly-sweep')).toBe(true);
    expect(isAutoRead(rules, 'cb-a', 'review')).toBe(true);
    expect(isAutoRead(rules, 'cb-b', 'review')).toBe(false);
    expect(isAutoRead(rules, null, 'review')).toBe(false);
  });
});

describe('unreadRunIdsOf', () => {
  test('keeps database candidates the auto-read list does not name', () => {
    const rules = { global: ['review'], byCodebase: new Map() };
    const runs = [
      { id: 'r1', codebase_id: 'cb-a', workflow_name: 'implement' },
      { id: 'r2', codebase_id: 'cb-a', workflow_name: 'review' },
      { id: 'r3', codebase_id: null, workflow_name: 'implement' },
    ];
    expect(unreadRunIdsOf(runs, new Set(['r1', 'r2']), rules)).toEqual(['r1']);
  });
});
