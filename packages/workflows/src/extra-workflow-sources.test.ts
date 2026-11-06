// @archon-test-isolated
/**
 * Workflows read from a git ref of the project's own repository: syncing a ref into a
 * snapshot, discovering from it, and freezing it into a run's capture.
 */
import { execFileAsync, GitFailure } from '@archon/git';
import { providerRegistry } from '@archon/providers';
import { readBundleIndex } from './defaults/bundle-inventory';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, sep } from 'path';

// The capture also freezes the bundled scope; empty indexed packs keep these tests about
// the extra source, as in workflow-source.test.ts.
const bundledDefaultsRoot = join(tmpdir(), `extra-sources-test-empty-bundled-${process.pid}`);
await mkdir(join(bundledDefaultsRoot, 'defaults'), { recursive: true });
for (const pack of await readBundleIndex())
  await mkdir(join(bundledDefaultsRoot, pack), { recursive: true });
afterAll(async () => {
  await removeTempTree(bundledDefaultsRoot);
});
const realArchonPaths = await import('@archon/paths');
mock.module('@archon/paths', () => ({
  ...realArchonPaths,
  getBundledWorkflowsPath: () => bundledDefaultsRoot,
}));

import { captureWorkflowSource, capturedSourceRoots, liveSourceRoots } from './workflow-source';
import {
  extraSourceDir,
  ExtraSourceNotSyncedError,
  ExtraSourceSyncError,
  readExtraSourceSnapshot,
  syncExtraSource,
} from './workflow-source/extra-sources';
import { extraWorkflowSourceSchema, type ExtraWorkflowSource } from './schemas/run-metadata';
import { discoverWorkflows, discoverWorkflowsWithConfig } from './workflow-discovery';
import { removeTempTree, trackTempRoots } from '@archon/paths/test-utils';

const trackTempRoot = trackTempRoots();
const PLANS: ExtraWorkflowSource = { ref: 'plans', path: '.' };

const workflowYaml = (name: string, description: string): string =>
  `name: ${name}\ndescription: ${description}\nnodes:\n  - id: hold\n    bash: "echo ${name}"\n`;

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args]);
  return stdout.trim();
}

/** A repository on `main` with a `plans` branch holding `workflows/plan.yaml`. */
async function createRepository(): Promise<{ project: string; home: string }> {
  const root = trackTempRoot(await mkdtemp(join(tmpdir(), 'archon-extra-')));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await git(project, 'init', '-q', '-b', 'main');
  await git(project, 'config', 'user.email', 'test@example.com');
  await git(project, 'config', 'user.name', 'Test');
  await writeFile(join(project, 'README.md'), 'code\n');
  await git(project, 'add', '.');
  await git(project, 'commit', '-q', '-m', 'code');

  await git(project, 'checkout', '-q', '--orphan', 'plans');
  await git(project, 'rm', '-rfq', '.');
  await mkdir(join(project, 'workflows'), { recursive: true });
  await writeFile(join(project, 'workflows', 'plan.yaml'), workflowYaml('plan', 'plan v1'));
  await git(project, 'add', '.');
  await git(project, 'commit', '-q', '-m', 'plan v1');
  await git(project, 'checkout', '-q', 'main');
  return { project, home: join(root, 'home') };
}

async function pushPlan(project: string, description: string): Promise<void> {
  await git(project, 'checkout', '-q', 'plans');
  await writeFile(join(project, 'workflows', 'plan.yaml'), workflowYaml('plan', description));
  await git(project, 'commit', '-q', '-am', description);
  await git(project, 'checkout', '-q', 'main');
}

let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.ARCHON_HOME;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.ARCHON_HOME;
  else process.env.ARCHON_HOME = previousHome;
});

describe('syncExtraSource', () => {
  test('snapshots the ref without touching the checkout', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;

    const result = await syncExtraSource(project, PLANS);

    expect(result.commit).toBe(await git(project, 'rev-parse', 'plans'));
    expect(result.fetched).toBe(false);
    const snapshot = await readExtraSourceSnapshot(project, PLANS);
    expect(snapshot?.meta.commit).toBe(result.commit);
    expect(await readFile(join(snapshot!.workflowsDir, 'plan.yaml'), 'utf8')).toContain('plan v1');
    expect(await git(project, 'branch', '--show-current')).toBe('main');
    expect(await git(project, 'status', '--porcelain')).toBe('');
  });

  test('a push to the ref changes nothing until the next sync', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const first = await syncExtraSource(project, PLANS);

    await pushPlan(project, 'plan v2');
    const before = await readExtraSourceSnapshot(project, PLANS);
    expect(before?.meta.commit).toBe(first.commit);
    expect(await readFile(join(before!.workflowsDir, 'plan.yaml'), 'utf8')).toContain('plan v1');

    const second = await syncExtraSource(project, PLANS);
    expect(second.commit).not.toBe(first.commit);
    const after = await readExtraSourceSnapshot(project, PLANS);
    expect(await readFile(join(after!.workflowsDir, 'plan.yaml'), 'utf8')).toContain('plan v2');
  });

  test('a ref that does not exist fails and names it', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await expect(syncExtraSource(project, { ref: 'missing', path: '.' })).rejects.toThrow(
      /"missing" does not exist/
    );
    expect(await readExtraSourceSnapshot(project, { ref: 'missing', path: '.' })).toBeUndefined();
  });

  test('a path without a workflows folder fails instead of syncing nothing', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await expect(syncExtraSource(project, { ref: 'main', path: '.' })).rejects.toThrow(
      /no "workflows\/" folder/
    );
  });

  test('a symlink in the ref is refused', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await git(project, 'checkout', '-q', 'plans');
    await symlink('plan.yaml', join(project, 'workflows', 'link.yaml'));
    await git(project, 'add', '.');
    await git(project, 'commit', '-q', '-m', 'link');
    await git(project, 'checkout', '-q', 'main');
    await expect(syncExtraSource(project, PLANS)).rejects.toThrow(/symlink/);
  });
});

describe('a failed sync', () => {
  test('keeps credentials in the remote URL out of the error message', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    // Port 1 refuses the connection, so the fetch fails without any real remote.
    await git(
      project,
      'remote',
      'add',
      'origin',
      'http://user:userinfoSecret@127.0.0.1:1/r?token=querySecret'
    );

    const error = await syncExtraSource(project, PLANS).then(
      () => undefined,
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(ExtraSourceSyncError);
    const failure = error as ExtraSourceSyncError;
    expect(failure.step).toBe('fetch');
    expect(failure.message).toContain('Could not fetch "plans" from remote "origin"');
    expect(failure.message).not.toContain('userinfoSecret');
    expect(failure.message).not.toContain('querySecret');
    // Git's own output stays available as evidence on the cause.
    expect(failure.cause).toBeInstanceOf(GitFailure);
    expect((failure.cause as GitFailure).stderr).toContain('querySecret');
  });
});

/** Every file path under `root`, relative to it. */
async function filesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) found.push(join(entry.parentPath, entry.name).slice(root.length + 1));
  }
  return found;
}

/** Point `plans` at a commit whose root tree is `entries` (`mode type oid\tname` lines). */
async function commitTree(project: string, entries: string[]): Promise<void> {
  const mktree = async (lines: string[]): Promise<string> =>
    (
      await execFileAsync('git', ['-C', project, 'mktree'], { input: `${lines.join('\n')}\n` })
    ).stdout.trim();
  const blob = (content: string): Promise<string> =>
    execFileAsync('git', ['-C', project, 'hash-object', '-w', '--stdin'], { input: content }).then(
      out => out.stdout.trim()
    );
  const workflow = await blob(workflowYaml('plan', 'crafted'));
  const workflows = await mktree([`100644 blob ${workflow}\tplan.yaml`]);
  const evil = await blob('evil\n');
  const resolved = await Promise.all(
    entries.map(async line =>
      line
        .replace('<evil-blob>', evil)
        .replace('<evil-tree>', await mktree([`100644 blob ${evil}\tevil`]))
    )
  );
  const root = await mktree([`040000 tree ${workflows}\tworkflows`, ...resolved]);
  const commit = (await git(project, 'commit-tree', root, '-m', 'crafted')).trim();
  await git(project, 'update-ref', 'refs/heads/plans', commit);
}

describe('the snapshot store', () => {
  test('a path spelled "./site" selects the same files as "site"', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await git(project, 'checkout', '-q', 'plans');
    await mkdir(join(project, 'site', 'workflows'), { recursive: true });
    await writeFile(join(project, 'site', 'workflows', 'site.yaml'), workflowYaml('site', 'site'));
    await git(project, 'add', '.');
    await git(project, 'commit', '-q', '-m', 'site');
    await git(project, 'checkout', '-q', 'main');

    const dotted = extraWorkflowSourceSchema.parse({ ref: 'plans', path: './site/' });
    expect(dotted).toEqual({ ref: 'plans', path: 'site' });
    expect(extraWorkflowSourceSchema.parse({ ref: 'plans', path: './' }).path).toBe('.');
    const result = await syncExtraSource(project, dotted);

    expect(result.files).toBe(1);
    const discovered = await discoverWorkflows(project, {
      providers: providerRegistry,
      loadDefaults: false,
      extraSources: [dotted],
    });
    expect(discovered.workflows.map(entry => entry.workflow.name)).toEqual(['site']);
  });

  for (const [label, entry, written] of [
    ['a ".." directory', '040000 tree <evil-tree>\t..', 'evil'],
    ['a name with backslashes', '100644 blob <evil-blob>\tback\\..\\..\\evil', 'evil'],
  ] as const) {
    test(`a tree entry with ${label} is refused before anything is written`, async () => {
      const { project, home } = await createRepository();
      process.env.ARCHON_HOME = home;
      await commitTree(project, [entry]);

      const error = await syncExtraSource(project, PLANS).then(
        () => undefined,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(ExtraSourceSyncError);
      expect((error as ExtraSourceSyncError).message).toContain('would leave the snapshot');
      expect(await readExtraSourceSnapshot(project, PLANS)).toBeUndefined();
      const root = dirname(home);
      expect((await filesUnder(root)).filter(file => file.endsWith(written))).toEqual([]);
    });
  }

  test('two syncs of one source at once both finish with a complete snapshot', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;

    const results = await Promise.all([
      syncExtraSource(project, PLANS),
      syncExtraSource(project, PLANS),
    ]);

    const commit = await git(project, 'rev-parse', 'plans');
    expect(results.map(result => result.commit)).toEqual([commit, commit]);
    const snapshot = await readExtraSourceSnapshot(project, PLANS);
    expect(snapshot?.meta.commit).toBe(commit);
    expect(await readFile(join(snapshot!.workflowsDir, 'plan.yaml'), 'utf8')).toContain('plan v1');
    const dir = await extraSourceDir(project, PLANS);
    expect(await readdir(join(dir, 'staging'))).toEqual([]);
  });

  test('a reader never sees a missing snapshot or files of another commit during syncs', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const descriptions = new Map<string, string>();
    descriptions.set((await syncExtraSource(project, PLANS)).commit, 'plan v1');

    let syncing = true;
    const reads: { commit: string | undefined; text: string }[] = [];
    const reader = (async () => {
      while (syncing) {
        const snapshot = await readExtraSourceSnapshot(project, PLANS);
        const text = snapshot
          ? await readFile(join(snapshot.workflowsDir, 'plan.yaml'), 'utf8')
          : '';
        reads.push({ commit: snapshot?.meta.commit, text });
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    for (let round = 2; round <= 6; round++) {
      await pushPlan(project, `plan v${round}`);
      descriptions.set((await syncExtraSource(project, PLANS)).commit, `plan v${round}`);
    }
    syncing = false;
    await reader;

    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.commit).toBeDefined();
      expect(read.text).toContain(`description: ${descriptions.get(read.commit!)}\n`);
    }
  });

  test('a linked worktree reads the snapshot synced from the primary checkout', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const worktree = join(dirname(project), 'adopted');
    await git(project, 'worktree', 'add', '-q', '-b', 'adopted', worktree);
    const synced = await syncExtraSource(project, PLANS);

    const captureRoot = join(dirname(home), 'captures', 'from-worktree');
    await captureWorkflowSource({
      sourceRoot: worktree,
      captureRoot,
      sourceConfig: {
        load_default_workflows: false,
        load_default_commands: false,
        extra_sources: [PLANS],
      },
    });

    const recorded = JSON.parse(
      await readFile(join(captureRoot, 'extra', '0', 'source.json'), 'utf8')
    ) as { commit: string };
    expect(recorded.commit).toBe(synced.commit);
  });

  test('a fetch records the commit it fetched and leaves no ref behind', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const remote = join(dirname(project), 'remote.git');
    await execFileAsync('git', ['clone', '-q', '--bare', project, remote]);
    await git(project, 'remote', 'add', 'origin', remote);
    // The remote moves on; the local branch does not.
    await execFileAsync('git', [
      '-C',
      remote,
      'update-ref',
      'refs/heads/plans',
      await git(project, 'rev-parse', 'plans'),
    ]);
    await pushPlan(project, 'local only');
    const remoteCommit = await git(remote, 'rev-parse', 'plans');

    const result = await syncExtraSource(project, PLANS);

    expect(result.fetched).toBe(true);
    expect(result.commit).toBe(remoteCommit);
    expect(await git(project, 'for-each-ref', 'refs/archon')).toBe('');
    expect(await git(project, 'rev-parse', 'plans')).not.toBe(remoteCommit);
  });

  test('superseded generations are removed once they and their successor are old', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const dir = await extraSourceDir(project, PLANS);
    const generations = join(dir, 'generations');
    await syncExtraSource(project, PLANS);
    const [first] = await readdir(generations);
    await syncExtraSource(project, PLANS);
    await syncExtraSource(project, PLANS);
    expect((await readdir(generations)).length).toBe(3);

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of await readdir(generations)) await utimes(join(generations, name), old, old);
    await syncExtraSource(project, PLANS);

    const kept = await readdir(generations);
    expect(kept).not.toContain(first);
    expect(kept.length).toBe(2);
    const snapshot = await readExtraSourceSnapshot(project, PLANS);
    expect(snapshot?.dir.startsWith(generations + sep)).toBe(true);
  });
});

describe('the config entry', () => {
  test('defaults the path and rejects what leaves the repository', () => {
    expect(extraWorkflowSourceSchema.parse({ ref: 'plans' })).toEqual({ ref: 'plans', path: '.' });
    for (const bad of [
      { ref: 'plans', path: '../outside' },
      { ref: 'plans', path: '/etc' },
      { ref: 'plans', path: 'C:\\x' },
      { ref: '--upload-pack=x', path: '.' },
      { ref: 'has space', path: '.' },
      { ref: 'plans', path: '.', extra: 1 },
    ]) {
      expect(extraWorkflowSourceSchema.safeParse(bad).success).toBe(false);
    }
  });

  test('refuses a refspec as the ref, which could move a local branch', () => {
    for (const ref of [
      'src:dst',
      'plans:release',
      '+refs/heads/plans:refs/heads/release',
      '+plans',
      'refs/heads/*',
      ':plans',
    ]) {
      const parsed = extraWorkflowSourceSchema.safeParse({ ref });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('not a refspec');
    }
  });

  test('accepts a branch, a tag, a full ref and a commit', () => {
    for (const ref of ['plans', 'v1.2.0', 'refs/heads/x', 'refs/tags/v1', 'a'.repeat(40)]) {
      expect(extraWorkflowSourceSchema.parse({ ref })).toEqual({ ref, path: '.' });
    }
  });
});

describe('discovery from an extra source', () => {
  const options = (extraSources: readonly ExtraWorkflowSource[]) => ({
    providers: providerRegistry,
    loadDefaults: false,
    extraSources,
  });

  test('lists the synced workflows as project workflows', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await syncExtraSource(project, PLANS);

    const result = await discoverWorkflows(project, options([PLANS]));

    const plan = result.workflows.find(entry => entry.workflow.name === 'plan');
    expect(plan?.source).toBe('project');
    expect(result.errors).toEqual([]);
  });

  test('a project file of the same name wins', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await syncExtraSource(project, PLANS);
    await mkdir(join(project, '.archon', 'workflows'), { recursive: true });
    await writeFile(
      join(project, '.archon', 'workflows', 'plan.yaml'),
      workflowYaml('plan', 'from the project')
    );

    const result = await discoverWorkflows(project, options([PLANS]));

    const plans = result.workflows.filter(entry => entry.workflow.name === 'plan');
    expect(plans.map(entry => entry.workflow.description)).toEqual(['from the project']);
  });

  test('a source that was never synced is a load error that names the fix', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;

    const result = await discoverWorkflows(project, options([PLANS]));

    expect(result.workflows.find(entry => entry.workflow.name === 'plan')).toBeUndefined();
    expect(result.errors.map(error => error.error).join('\n')).toContain('archon workflow sync');
  });

  test('a linked worktree that reads source from the project lists the configured source', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const worktree = join(dirname(project), 'worktree');
    await git(project, 'worktree', 'add', '-q', '-b', 'feature', worktree);
    await syncExtraSource(project, PLANS);

    const result = await discoverWorkflowsWithConfig(
      worktree,
      () => Promise.resolve({ extraWorkflowSources: [PLANS] }),
      providerRegistry,
      liveSourceRoots(project)
    );

    expect(result.workflows.map(entry => entry.workflow.name)).toContain('plan');
    expect(result.errors).toEqual([]);
  });

  test('a project with no extra sources behaves as before', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const result = await discoverWorkflows(project, options([]));
    expect(result.workflows).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe('a run captures the extra source', () => {
  const sourceConfig = {
    load_default_workflows: false,
    load_default_commands: false,
    extra_sources: [PLANS],
  };

  test('later pushes and syncs never reach a captured run', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    const first = await syncExtraSource(project, PLANS);
    const captureRoot = join(dirname(home), 'captures', 'run-1');
    const capture = await captureWorkflowSource({
      sourceRoot: project,
      captureRoot,
      sourceConfig,
    });
    expect(capture.manifest.scopes).toContain('extra');
    const recorded = JSON.parse(
      await readFile(join(captureRoot, 'extra', '0', 'source.json'), 'utf8')
    ) as { commit: string };
    expect(recorded.commit).toBe(first.commit);

    await pushPlan(project, 'plan v2');
    await syncExtraSource(project, PLANS);

    const frozen = await discoverWorkflows(project, {
      providers: providerRegistry,
      sourceRoots: capturedSourceRoots(capture.anchor),
    });
    expect(
      frozen.workflows
        .filter(entry => entry.workflow.name === 'plan')
        .map(e => e.workflow.description)
    ).toEqual(['plan v1']);
  });

  test('a configured source that was never synced fails the capture', async () => {
    const { project, home } = await createRepository();
    process.env.ARCHON_HOME = home;
    await expect(
      captureWorkflowSource({
        sourceRoot: project,
        captureRoot: join(dirname(home), 'captures', 'run-2'),
        sourceConfig,
      })
    ).rejects.toBeInstanceOf(ExtraSourceNotSyncedError);
  });
});
