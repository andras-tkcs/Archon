import type { ReactElement } from 'react';
import type { RunStatus } from '../lib/run-status';
import type { RunCounts } from '../skills/runs';
import { UNREAD_BG_CLASS } from '../lib/unread';

export type Filter = 'all' | RunStatus;

interface FilterChipsProps {
  value: Filter;
  onChange: (next: Filter) => void;
  counts: RunCounts;
  /** Unread finished runs per bucket; a non-zero bucket highlights its count. */
  unread: RunCounts;
}

// Order reflects the typical user journey: what's happening now (running),
// what needs me (paused), what's broken (failed), then the retrospective
// buckets (completed, all) at the end.
const ORDER: readonly {
  filter: Filter;
  label: string;
  countKey: keyof RunCounts;
}[] = [
  { filter: 'running', label: 'Running', countKey: 'running' },
  { filter: 'paused', label: 'Paused', countKey: 'paused' },
  { filter: 'failed', label: 'Failed', countKey: 'failed' },
  { filter: 'completed', label: 'Completed', countKey: 'completed' },
  { filter: 'all', label: 'All', countKey: 'all' },
];

export function FilterChips({ value, onChange, counts, unread }: FilterChipsProps): ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      {ORDER.map(({ filter, label, countKey }) => {
        const active = value === filter;
        const n = counts[countKey];
        const unreadCount = unread[countKey];
        const hasUnread = unreadCount > 0;
        return (
          <button
            key={filter}
            type="button"
            onClick={() => {
              onChange(filter);
            }}
            className={`relative mr-5 inline-flex items-center gap-2 px-1 pb-[13px] pt-2 font-mono text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors ${
              active ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
            }`}
            aria-pressed={active}
          >
            {label}
            <span
              className={`min-w-[20px] rounded-full border px-[7px] py-px text-center font-mono text-[10.5px] font-bold tabular-nums ${
                hasUnread
                  ? `${UNREAD_BG_CLASS} border-transparent text-text-primary`
                  : active
                    ? 'border-transparent bg-accent-bright/20 text-text-primary'
                    : 'bg-surface-elevated text-text-secondary'
              }`}
              // Inline because the console scope's wildcard border-color rule
              // repaints Tailwind border utilities (see theme.css).
              style={{ borderColor: active || hasUnread ? 'transparent' : 'var(--border)' }}
              title={hasUnread ? `${String(unreadCount)} unread` : undefined}
              data-unread={hasUnread ? '' : undefined}
            >
              {n}
              {hasUnread ? <span className="sr-only">, {unreadCount} unread</span> : null}
            </span>
            {active ? (
              <span
                aria-hidden
                className="brand-bar pointer-events-none absolute inset-x-0 -bottom-px h-0.5 rounded-full"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
