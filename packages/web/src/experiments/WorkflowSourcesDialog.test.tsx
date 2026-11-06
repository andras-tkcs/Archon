import { afterEach, expect, mock, test } from 'bun:test';
import * as React from 'react';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpError } from './console/lib/http';
import { get, invalidate, set, subscribeKey } from './console/store/cache';
import { K } from './console/store/keys';

const states: unknown[] = [];
let cursor = 0;
let renderingBody = false;
const react = { ...React };
// Retain the dialog body's state across server renders, as in DraftRunCardInteraction.
// The isolated package-test group prevents this React mock leaking to other tests.
mock.module('react', () => ({
  ...react,
  useState: <T,>(initial: T | (() => T)): [T, React.Dispatch<React.SetStateAction<T>>] => {
    if (!renderingBody) return react.useState(initial);
    const index = cursor++;
    if (!(index in states))
      states[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    return [
      states[index] as T,
      value => {
        states[index] =
          typeof value === 'function' ? (value as (previous: T) => T)(states[index] as T) : value;
      },
    ];
  },
}));
const { WorkflowSourcesDialog } = await import('./console/components/WorkflowSourcesDialog');

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const usedKeys: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  states.length = 0;
  for (const key of usedKeys.splice(0)) invalidate(key);
});

function status(ref: string, path: string, commit: string | null) {
  return {
    ref,
    path,
    snapshot:
      commit === null ? null : { commit, synced_at: '2026-11-06T12:00:00.000Z', fetched: true },
  };
}

function respondToSync(status: number, body: unknown): void {
  globalThis.window = { location: { origin: 'http://localhost' } } as typeof globalThis.window;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    expect(String(input)).toEndWith('/sync');
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function elements(node: ReactNode): ReactElement[] {
  const result: ReactElement[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return;
    result.push(child, ...elements(child.props.children));
  });
  return result;
}

/** Render the dialog's body as a function, so its buttons' handlers can be called. */
function dialog(projectId: string) {
  usedKeys.push(K.extraSources(projectId));
  let tree: ReactNode;
  function Probe(): ReactElement {
    const outer = WorkflowSourcesDialog({
      projectId,
      projectName: 'demo',
      open: true,
      onClose: () => {},
    });
    const body = elements(outer).find(element => typeof element.type === 'function');
    if (body === undefined) throw new Error('Missing dialog body');
    cursor = 0;
    renderingBody = true;
    try {
      const rendered = (body.type as (props: unknown) => ReactElement)(body.props);
      tree = rendered;
      return rendered;
    } finally {
      renderingBody = false;
    }
  }
  const render = (): string => renderToStaticMarkup(<Probe />);
  const sync = async (): Promise<void> => {
    render();
    const button = elements(tree).find(
      element =>
        element.type === 'button' &&
        renderToStaticMarkup(element as ReactElement).includes('Sync now')
    );
    if (!isValidElement<{ onClick: () => void; disabled?: boolean }>(button))
      throw new Error('Missing Sync now button');
    expect(button.props.disabled).toBe(false);
    button.props.onClick();
    for (let i = 0; i < 5; i++) await flush();
  };
  return { render, sync };
}

test('a list response that started before a sync cannot overwrite its result', async () => {
  const key = K.extraSources('p-stale');
  set(key, [status('plans', '.', COMMIT_A)]);
  let settleList: (value: unknown) => void = () => {};
  const unsubscribe = subscribeKey(
    key,
    () => {},
    () =>
      new Promise(resolve => {
        settleList = resolve;
      })
  );
  try {
    // The dialog's open-time refresh: a list request is now in flight.
    invalidate(key);
    respondToSync(200, {
      ok: true,
      sources: [{ ...status('plans', '.', COMMIT_B), outcome: 'synced' }],
    });
    const view = dialog('p-stale');

    await view.sync();
    settleList([status('plans', '.', COMMIT_A)]);
    await flush();

    expect((get(key) as ReturnType<typeof status>[])[0]?.snapshot?.commit).toBe(COMMIT_B);
    expect(view.render()).toContain(COMMIT_B.slice(0, 12));
  } finally {
    unsubscribe();
  }
});

test('a failed sync request shows the full server error and detail and drops the stale list', async () => {
  const key = K.extraSources('p-error');
  set(key, [status('plans', '.', COMMIT_A)]);
  const summary = `Invalid extraWorkflowSources config: 0.ref ${'x'.repeat(250)} SUMMARY-TAIL`;
  respondToSync(422, { error: summary, detail: 'DETAIL-TAIL' });
  const view = dialog('p-error');

  await view.sync();

  const markup = view.render();
  expect(markup).toContain('role="alert"');
  expect(markup).toContain(`SUMMARY-TAIL: DETAIL-TAIL`);
  expect(markup).not.toContain('{&quot;error');
  expect(get(key)).toBeUndefined();
});

test('a partial sync names each failure and the sources it never attempted', async () => {
  const key = K.extraSources('p-partial');
  set(key, [
    status('plans', '.', COMMIT_A),
    status('docs', '.', null),
    status('later', 'site', null),
  ]);
  respondToSync(200, {
    ok: false,
    sources: [
      { ...status('plans', '.', COMMIT_B), outcome: 'synced' },
      { ...status('docs', '.', null), outcome: 'failed', error: 'FETCH-FAILED for docs' },
      { ...status('later', 'site', null), outcome: 'not_attempted' },
    ],
  });
  const view = dialog('p-partial');

  await view.sync();

  const markup = view.render();
  expect(markup).toContain('docs: FETCH-FAILED for docs');
  expect(markup).toContain('Not attempted: later:site');
  expect(markup).toContain(COMMIT_B.slice(0, 12));
});

test('an invalid config shows its summary instead of an empty, disabled dialog', async () => {
  const key = K.extraSources('p-invalid');
  const summary = `Invalid extraWorkflowSources config: 0.ref ${'x'.repeat(250)} CONFIG-TAIL`;
  const unsubscribe = subscribeKey(
    key,
    () => {},
    () => Promise.reject(new HttpError(422, '/api/codebases/p-invalid/extra-sources', '', summary))
  );
  try {
    await flush();
    const markup = dialog('p-invalid').render();
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('CONFIG-TAIL');
  } finally {
    unsubscribe();
  }
});
