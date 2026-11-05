import { describe, expect, it } from 'bun:test';
import { childOutcomeFromRun, childPauseReason } from './child-run';
import type { WorkflowRun } from '../schemas';

function settledRun(
  metadata: Record<string, unknown>,
  status: WorkflowRun['status'] = 'completed'
): WorkflowRun {
  return {
    origin: { conversationId: 'conv-child' },
    id: 'child-1',
    workflow_name: 'child',
    conversation_id: 'conv-child',
    parent_conversation_id: null,
    codebase_id: null,
    status,
    outcome: null,
    user_message: 'child input',
    metadata,
    started_at: new Date(),
    completed_at: null,
    last_activity_at: null,
    working_path: null,
    user_id: null,
    parent_run_id: null,
    output_root: null,
    checkout_baseline: null,
    adopted_from_run_id: null,
  };
}

describe('childOutcomeFromRun cache reporting', () => {
  it('carries a child run total that is only a floor up to its parent', () => {
    const outcome = childOutcomeFromRun(
      settledRun({
        total_tokens_in: 100,
        total_tokens_out: 10,
        total_cache_read_tokens: 60,
        total_cache_write_tokens: 0,
        total_cache_partial: true,
      })
    );

    // Reading the numbers but not the flag let a parent merge a child's floor as
    // though it were exact, which is the same defect one run boundary up.
    expect(outcome.tokens).toEqual({
      input: 100,
      output: 10,
      cacheRead: 60,
      cacheWrite: 0,
      cachePartial: true,
    });
  });

  it.each([true, null, 'false', 0, undefined, {}, []].map(marker => ({ marker })))(
    'keeps a present unknown marker unavailable despite numeric metadata: %j',
    ({ marker }) => {
      const outcome = childOutcomeFromRun(
        settledRun({
          total_tokens_unknown: marker,
          total_tokens_in: 170,
          total_tokens_out: 20,
          total_cost_usd: 0.3,
        })
      );
      expect(outcome.tokens).toBeUndefined();
      expect(outcome.tokensUnknown).toBe(true);
      expect(outcome.costUsd).toBe(0.3);
    }
  );

  it('leaves a complete child total unflagged', () => {
    const outcome = childOutcomeFromRun(
      settledRun({
        total_tokens_in: 100,
        total_tokens_out: 10,
        total_cache_read_tokens: 60,
        total_cache_write_tokens: 0,
      })
    );

    expect(outcome.tokens).toEqual({
      input: 100,
      output: 10,
      cacheRead: 60,
      cacheWrite: 0,
    });
    // toEqual alone would still pass on `cachePartial: undefined`; the key must be absent,
    // because absence is what every reader treats as "this total is exact".
    expect(outcome.tokens).not.toHaveProperty('cachePartial');
  });
});

describe('childOutcomeFromRun historical required counters', () => {
  it.each([
    { total_tokens_in: 100 },
    { total_tokens_out: 10 },
    { total_tokens_in: 100, total_tokens_out: 'unreadable' },
    { total_tokens_in: 'unreadable', total_tokens_out: 10 },
    { total_tokens_in: null, total_tokens_out: null },
    { total_tokens_in: NaN, total_tokens_out: 10 },
    { total_tokens_in: 100, total_tokens_out: Infinity },
  ])('keeps malformed counters unknown: %j', metadata => {
    const outcome = childOutcomeFromRun(settledRun({ ...metadata, total_cost_usd: 0.3 }));
    expect(outcome.tokensUnknown).toBe(true);
    expect(outcome.tokens).toBeUndefined();
    expect(outcome.costUsd).toBe(0.3);
    expect(outcome.status).toBe('completed');
  });

  it('preserves absent usage and valid zero totals', () => {
    const absent = childOutcomeFromRun(settledRun({}));
    expect(absent.tokens).toBeUndefined();
    expect(absent.tokensUnknown).toBeUndefined();
    const zero = childOutcomeFromRun(
      settledRun({ total_tokens_in: 0, total_tokens_out: 0, total_tokens_unknown: false })
    );
    expect(zero.tokens).toEqual({ input: 0, output: 0 });
    expect(zero.tokensUnknown).toBeUndefined();
  });
});

describe('childPauseReason', () => {
  const since = '2026-11-05T10:00:00.000Z';
  const resumeAt = '2026-11-05T10:10:00.000Z';
  const owner = { owner: 'node', nodeId: 'pause' };

  it.each([
    {
      name: 'open approval gate',
      metadata: { approval: { nodeId: 'gate', message: 'review', type: 'approval' } },
      expected: { kind: 'answerable' },
    },
    {
      name: 'unanswered attention wait',
      metadata: { wait: { ...owner, kind: 'attention', waitingSince: since, message: 'which?' } },
      expected: { kind: 'answerable' },
    },
    {
      name: 'time wait',
      metadata: { wait: { ...owner, kind: 'time', waitingSince: since, resumeAt } },
      expected: { kind: 'time', resumeAt },
    },
    {
      name: 'event wait',
      metadata: {
        wait: { ...owner, kind: 'event', waitingSince: since, resumeAt, event: 'pr.merged' },
      },
      expected: { kind: 'event', event: 'pr.merged', resumeAt },
    },
    {
      name: 'usage-limit wait',
      metadata: { wait: { ...owner, kind: 'quota', pauseId: 'p1', waitingSince: since, resumeAt } },
      expected: { kind: 'quota', resumeAt },
    },
    {
      name: 'blocked on its own sub-run',
      metadata: {
        approval: { nodeId: 'sub', message: 'blocked', type: 'child_workflow', childRunId: 'gc-1' },
      },
      expected: { kind: 'nested', childRunIds: ['gc-1'] },
    },
    {
      name: 'blocked on its own fan-out',
      metadata: {
        approval: { nodeId: 'fan', message: 'blocked', type: 'fan_out', childRunIds: ['a', 'b'] },
      },
      expected: { kind: 'nested', childRunIds: ['a', 'b'] },
    },
    {
      name: 'paused with nothing recorded',
      metadata: {},
      expected: {
        kind: 'unreadable',
        detail: 'paused with no approval gate and no durable wait recorded',
      },
    },
    {
      name: 'resolved gate awaiting auto-resume',
      metadata: {
        approval: { nodeId: 'gate', message: 'review', type: 'approval', resolved: 'approved' },
      },
      expected: { kind: 'unfinished' },
    },
  ])('paused child, $name', ({ metadata, expected }) => {
    expect(childPauseReason(settledRun(metadata, 'paused'))).toEqual(expected);
  });

  it('a running child is unfinished', () => {
    expect(childPauseReason(settledRun({}, 'running'))).toEqual({ kind: 'unfinished' });
  });

  it('childOutcomeFromRun carries the reason for a paused child only', () => {
    const wait = { ...owner, kind: 'time', waitingSince: since, resumeAt };
    expect(childOutcomeFromRun(settledRun({ wait }, 'paused')).pause).toEqual({
      kind: 'time',
      resumeAt,
    });
    expect(childOutcomeFromRun(settledRun({})).pause).toBeUndefined();
  });
});
