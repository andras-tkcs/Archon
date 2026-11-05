import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunCounts } from '../skills/runs';
import { FilterChips } from './FilterChips';

const ZERO: RunCounts = {
  all: 0,
  running: 0,
  paused: 0,
  failed: 0,
  completed: 0,
  cancelled: 0,
  pending: 0,
};

function chipFor(html: string, label: string): string {
  const chip = html.split('</button>').find(part => part.includes(`>${label}<`));
  if (chip === undefined) throw new Error(`No ${label} chip`);
  return chip;
}

describe('FilterChips', () => {
  test('highlights the count of a bucket that holds unread runs, and only that bucket', () => {
    const html = renderToStaticMarkup(
      <FilterChips
        value="running"
        onChange={() => undefined}
        counts={{ ...ZERO, all: 9, failed: 7, completed: 2 }}
        unread={{ ...ZERO, all: 3, failed: 3 }}
      />
    );

    const failed = chipFor(html, 'Failed');
    expect(failed).toContain('data-unread');
    expect(failed).toContain('title="3 unread"');
    expect(failed).toContain(', 3 unread');
    expect(chipFor(html, 'All')).toContain('data-unread');

    const completed = chipFor(html, 'Completed');
    expect(completed).not.toContain('data-unread');
    expect(completed).not.toContain('unread');
  });
});
