import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { execFileAsync, getCanonicalRepoPath, GitFailure } from '@archon/git';
import * as archonPaths from '@archon/paths';
import { z } from 'zod';
import type { ExtraWorkflowSource } from '../schemas/run-metadata';
import { getLog } from './log';

/**
 * Workflows read from a git ref of the project's own repository.
 *
 * Git is touched in exactly one place, {@link syncExtraSource}: it resolves the ref to a
 * commit and writes that commit's tree into a snapshot under `ARCHON_HOME`. Discovery and
 * capture then read the snapshot like any other folder, so a run can never see a ref that
 * moved after its capture, and nothing here runs in the background.
 *
 * Layout, one source directory per (repository, ref, path):
 *   `<source>/current`               the name of the published generation
 *   `<source>/generations/<id>/`     immutable once published: `source.json` and `tree/`
 *   `<source>/staging/<id>/`         a generation being built; never read
 *
 * A sync builds a whole generation in `staging/`, renames it into `generations/`, then
 * replaces `current` by renaming a new pointer file over it. A reader resolves `current`
 * once and reads only that generation, so it never sees a missing snapshot during a sync
 * and never mixes the files of two commits.
 */

const POINTER_FILE = 'current';
const GENERATIONS_DIR = 'generations';
const STAGING_DIR = 'staging';
const SNAPSHOT_META_FILE = 'source.json';
const SNAPSHOT_TREE_DIR = 'tree';
/** The folder in the tree that holds workflows, like `.archon/workflows` in a project. */
export const EXTRA_WORKFLOWS_DIR = 'workflows';
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const GENERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * How long a superseded generation, or an abandoned staging directory, outlives the
 * sync that made it so. A reader takes seconds; this bounds what accumulates without
 * tracking readers.
 */
const SUPERSEDED_GENERATION_GRACE_MS = 60 * 60 * 1000;

const snapshotMetaSchema = z
  .object({
    ref: z.string(),
    path: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    synced_at: z.string(),
    /** False when the repository has no remote to fetch from and the ref was read locally. */
    fetched: z.boolean(),
  })
  .strict();

export type ExtraSourceSnapshotMeta = z.infer<typeof snapshotMetaSchema>;

export interface ExtraSourceSnapshot {
  /** The published generation's directory, which holds `source.json` and `tree/`. */
  readonly dir: string;
  /** Where the ref's workflows are: `<dir>/tree/workflows`. */
  readonly workflowsDir: string;
  readonly meta: ExtraSourceSnapshotMeta;
}

/** Thrown when a configured source has no snapshot yet; its message names the fix. */
export class ExtraSourceNotSyncedError extends Error {
  constructor(source: ExtraWorkflowSource) {
    super(
      `Extra workflow source "${source.ref}" (path "${source.path}") has not been synced. ` +
        'Run `archon workflow sync` in this project.'
    );
    this.name = 'ExtraSourceNotSyncedError';
  }
}

/** The operation a failed sync was performing. */
export type ExtraSourceSyncStep = 'fetch' | 'resolve' | 'list' | 'read' | 'validate' | 'cleanup';

/**
 * A sync of one extra source failed. Archon writes the message itself from the
 * configured ref and path, a remote name and paths inside the ref, so it is safe to show
 * and log. Git's own output, which can echo a remote URL with its credentials, is kept
 * only on `cause`.
 */
export class ExtraSourceSyncError extends Error {
  /** Git's exit code when a git command failed. */
  readonly gitExitCode: number | undefined;

  constructor(
    readonly source: ExtraWorkflowSource,
    readonly step: ExtraSourceSyncStep,
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExtraSourceSyncError';
    this.gitExitCode =
      cause instanceof GitFailure && typeof cause.code === 'number' ? cause.code : undefined;
  }
}

function hashOf(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/**
 * The directory of `source` for the repository checked out at `projectRoot`.
 *
 * Keyed by the repository's primary checkout, so every linked worktree, including an
 * adopted one, reads the snapshot a sync from any of them wrote: worktrees share refs
 * and objects, so a ref's tree is the same from each. Moving the repository means
 * syncing again, which reports itself as "not synced" instead of reading another
 * repository's snapshot.
 */
export async function extraSourceDir(
  projectRoot: string,
  source: ExtraWorkflowSource
): Promise<string> {
  const repository = hashOf(await realpath(await getCanonicalRepoPath(projectRoot))).slice(0, 16);
  return join(
    archonPaths.getArchonHome(),
    'extra-sources',
    repository,
    hashOf(source.ref, source.path).slice(0, 16)
  );
}

/** The published generation of the source at `dir`, or undefined before its first sync. */
async function publishedGeneration(dir: string): Promise<string | undefined> {
  let pointer: string;
  try {
    pointer = (await readFile(join(dir, POINTER_FILE), 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!GENERATION_ID.test(pointer)) {
    throw new Error(
      `Extra workflow source snapshot pointer ${join(dir, POINTER_FILE)} is corrupt.`
    );
  }
  return pointer;
}

/** The snapshot of `source`, or undefined when it was never synced. */
export async function readExtraSourceSnapshot(
  projectRoot: string,
  source: ExtraWorkflowSource
): Promise<ExtraSourceSnapshot | undefined> {
  const dir = await extraSourceDir(projectRoot, source);
  const generation = await publishedGeneration(dir);
  if (generation === undefined) return undefined;
  const generationDir = join(dir, GENERATIONS_DIR, generation);
  const raw = await readFile(join(generationDir, SNAPSHOT_META_FILE), 'utf8');
  const meta = snapshotMetaSchema.parse(JSON.parse(raw));
  return {
    dir: generationDir,
    workflowsDir: join(generationDir, SNAPSHOT_TREE_DIR, EXTRA_WORKFLOWS_DIR),
    meta,
  };
}

export interface ExtraSourceSyncResult {
  source: ExtraWorkflowSource;
  commit: string;
  fetched: boolean;
  files: number;
}

interface GitCall {
  source: ExtraWorkflowSource;
  step: ExtraSourceSyncStep;
  /** The error message, given git's exit code as text such as ` (git exit code 128)`. */
  failure: (exit: string) => string;
  maxBuffer?: number;
}

/** Every git command of a sync runs here, so none of git's output reaches a message. */
async function git(projectRoot: string, args: string[], call: GitCall): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectRoot, ...args], {
      ...(call.maxBuffer ? { maxBuffer: call.maxBuffer } : {}),
    });
    return stdout;
  } catch (error) {
    // execFile reports output beyond maxBuffer as a RangeError holding that output.
    if (error instanceof RangeError) {
      throw new ExtraSourceSyncError(
        call.source,
        call.step,
        call.failure(' (git output exceeded the size limit)'),
        error
      );
    }
    if (!(error instanceof GitFailure)) throw error;
    const exit = typeof error.code === 'number' ? ` (git exit code ${error.code})` : '';
    throw new ExtraSourceSyncError(call.source, call.step, call.failure(exit), error);
  }
}

/** `git remote get-url` exits 2 when the remote does not exist. */
const NO_SUCH_REMOTE_EXIT = 2;

async function hasRemote(
  projectRoot: string,
  source: ExtraWorkflowSource,
  remote: string
): Promise<boolean> {
  try {
    await git(projectRoot, ['remote', 'get-url', remote], {
      source,
      step: 'fetch',
      failure: exit => `Could not read remote "${remote}" of the repository${exit}.`,
    });
    return true;
  } catch (error) {
    if (error instanceof ExtraSourceSyncError && error.gitExitCode === NO_SUCH_REMOTE_EXIT) {
      return false;
    }
    throw error;
  }
}

/**
 * Resolve `source.ref` to a commit. With a remote the ref is fetched first, into a ref
 * of this sync's own, so a concurrent fetch (which rewrites the shared `FETCH_HEAD`)
 * cannot change which commit is recorded. A fetch that fails is an error, never a quiet
 * fall back to a stale local copy. Only a repository with no such remote reads the ref
 * locally, and the result says so.
 */
async function resolveCommit(
  projectRoot: string,
  source: ExtraWorkflowSource,
  remote: string
): Promise<{ commit: string; fetched: boolean }> {
  if (await hasRemote(projectRoot, source, remote)) {
    // The schema refuses ":" in a ref, so this refspec has exactly the source and
    // destination written here.
    const fetchRef = `refs/archon/extra-sources/fetch-${randomUUID()}`;
    try {
      await git(
        projectRoot,
        ['fetch', '--quiet', '--no-tags', remote, `${source.ref}:${fetchRef}`],
        {
          source,
          step: 'fetch',
          failure: exit =>
            `Could not fetch "${source.ref}" from remote "${remote}"${exit}. ` +
            `Run \`git fetch ${remote} ${source.ref}\` in the project to see git's error.`,
        }
      );
      const commit = (
        await git(projectRoot, ['rev-parse', '--verify', `${fetchRef}^{commit}`], {
          source,
          step: 'resolve',
          failure: exit => `Could not resolve the commit fetched for "${source.ref}"${exit}.`,
        })
      ).trim();
      return { commit, fetched: true };
    } finally {
      // Deleting a ref that a failed fetch never created succeeds.
      await git(projectRoot, ['update-ref', '-d', fetchRef], {
        source,
        step: 'cleanup',
        failure: exit => `Could not delete the temporary ref ${fetchRef}${exit}.`,
      });
    }
  }
  const commit = (
    await git(projectRoot, ['rev-parse', '--verify', `${source.ref}^{commit}`], {
      source,
      step: 'resolve',
      failure: () =>
        `Extra workflow source "${source.ref}" does not exist in this repository, which has no ` +
        `remote "${remote}" to fetch it from.`,
    })
  ).trim();
  return { commit, fetched: false };
}

interface TreeEntry {
  mode: string;
  oid: string;
  /** Path relative to the source's `path`. */
  rel: string;
}

/**
 * Whether `rel` names a file strictly inside the snapshot tree on every platform. Git
 * accepts tree entries named `..` and names holding `\`, which Windows reads as a
 * separator, so a commit can carry a path that would resolve outside the tree.
 */
function isContainedTreePath(rel: string): boolean {
  if (rel === '' || rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) {
    return false;
  }
  return rel.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

async function listTree(
  projectRoot: string,
  commit: string,
  source: ExtraWorkflowSource
): Promise<TreeEntry[]> {
  const prefix = source.path === '.' ? '' : `${source.path}/`;
  const args = ['ls-tree', '-r', '-z', commit];
  if (prefix) args.push('--', prefix);
  const output = await git(projectRoot, args, {
    source,
    step: 'list',
    failure: exit => `Could not list the files of commit ${commit.slice(0, 12)}${exit}.`,
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const rel = record.slice(tab + 1).slice(prefix.length);
    if (type !== 'blob' || mode === '120000') {
      throw new ExtraSourceSyncError(
        source,
        'validate',
        `Extra workflow source "${source.ref}" holds ${mode === '120000' ? 'a symlink' : `a ${type}`} ` +
          `at "${prefix}${rel}"; only regular files can be synced.`
      );
    }
    if (!isContainedTreePath(rel)) {
      throw new ExtraSourceSyncError(
        source,
        'validate',
        `Extra workflow source "${source.ref}" holds a file whose path ${JSON.stringify(`${prefix}${rel}`)} ` +
          'would leave the snapshot; nothing was synced.'
      );
    }
    entries.push({ mode, oid, rel });
  }
  return entries;
}

/**
 * Write every entry and `meta` into `generationDir`, which must not exist yet. Each
 * `rel` passed {@link isContainedTreePath} in {@link listTree}, so it stays in the tree.
 */
async function writeGeneration(
  projectRoot: string,
  source: ExtraWorkflowSource,
  entries: readonly TreeEntry[],
  meta: ExtraSourceSnapshotMeta,
  generationDir: string
): Promise<void> {
  const treeDir = join(generationDir, SNAPSHOT_TREE_DIR);
  for (const entry of entries) {
    const target = join(treeDir, entry.rel);
    const content = await git(projectRoot, ['cat-file', 'blob', entry.oid], {
      source,
      step: 'read',
      failure: exit => `Could not read "${entry.rel}" from "${source.ref}"${exit}.`,
      maxBuffer: MAX_BLOB_BYTES,
    });
    if (content.includes('\0')) {
      throw new ExtraSourceSyncError(
        source,
        'validate',
        `Extra workflow source "${source.ref}" holds a binary file at "${entry.rel}"; only text ` +
          'files can be synced.'
      );
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
  await writeFile(join(generationDir, SNAPSHOT_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
}

async function olderThanGrace(path: string, now: number): Promise<boolean> {
  try {
    return now - (await stat(path)).mtimeMs > SUPERSEDED_GENERATION_GRACE_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Delete what no reader can still be using: a generation superseded before `previous`
 * was published, once both are older than the grace period, and abandoned staging. A
 * generation's own age also protects one another process has just renamed in but not
 * yet pointed `current` at.
 */
async function prune(dir: string, published: string, previous: string | undefined): Promise<void> {
  const now = Date.now();
  const generationsDir = join(dir, GENERATIONS_DIR);
  const previousIsOld =
    previous === undefined || (await olderThanGrace(join(generationsDir, previous), now));
  if (previousIsOld) {
    for (const name of await entriesOf(generationsDir)) {
      if (name === published || name === previous) continue;
      const generationDir = join(generationsDir, name);
      if (await olderThanGrace(generationDir, now)) {
        await rm(generationDir, { recursive: true, force: true });
      }
    }
  }
  const stagingDir = join(dir, STAGING_DIR);
  for (const name of await entriesOf(stagingDir)) {
    if (await olderThanGrace(join(stagingDir, name), now)) {
      await rm(join(stagingDir, name), { recursive: true, force: true });
    }
  }
}

/** The sync in progress per source directory, so syncs of one source run one at a time. */
const syncsInProgress = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const before = syncsInProgress.get(key) ?? Promise.resolve();
  const mine = before.then(run, run);
  const settled = mine.then(
    () => undefined,
    () => undefined
  );
  syncsInProgress.set(key, settled);
  try {
    return await mine;
  } finally {
    if (syncsInProgress.get(key) === settled) syncsInProgress.delete(key);
  }
}

/**
 * Write the tree of `source.ref` as a new generation of its snapshot and publish it.
 *
 * `remote` is the git remote to fetch from (the project's `worktree.remote`, else
 * `origin`). Syncs of one source in this process run one at a time. Each sync stages in
 * a directory of its own, so syncs from two processes cannot touch each other's files
 * either; each publishes a complete generation and the last one wins.
 */
export async function syncExtraSource(
  projectRoot: string,
  source: ExtraWorkflowSource,
  remote = 'origin'
): Promise<ExtraSourceSyncResult> {
  const dir = await extraSourceDir(projectRoot, source);
  return oneAtATime(dir, async () => {
    const { commit, fetched } = await resolveCommit(projectRoot, source, remote);
    const entries = await listTree(projectRoot, commit, source);
    if (!entries.some(entry => entry.rel.startsWith(`${EXTRA_WORKFLOWS_DIR}/`))) {
      throw new ExtraSourceSyncError(
        source,
        'validate',
        `Extra workflow source "${source.ref}" has no "${EXTRA_WORKFLOWS_DIR}/" folder at path ` +
          `"${source.path}" (commit ${commit.slice(0, 12)}).`
      );
    }

    const generation = randomUUID();
    const staging = join(dir, STAGING_DIR, generation);
    await mkdir(staging, { recursive: true });
    try {
      await writeGeneration(
        projectRoot,
        source,
        entries,
        {
          ref: source.ref,
          path: source.path,
          commit,
          synced_at: new Date().toISOString(),
          fetched,
        },
        staging
      );
      await mkdir(join(dir, GENERATIONS_DIR), { recursive: true });
      await rename(staging, join(dir, GENERATIONS_DIR, generation));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }

    const previous = await publishedGeneration(dir);
    const pointer = join(dir, `${POINTER_FILE}.${generation}.tmp`);
    await writeFile(pointer, `${generation}\n`);
    await rename(pointer, join(dir, POINTER_FILE));
    // The snapshot is published; a failed cleanup leaves only extra directories behind.
    await prune(dir, generation, previous).catch((error: unknown) => {
      getLog().warn({ err: error, dir }, 'workflow.extra_source_prune_failed');
    });
    return { source, commit, fetched, files: entries.length };
  });
}
