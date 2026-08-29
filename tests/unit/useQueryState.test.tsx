import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useQueryState } from '@lib/useQueryState';

export {};

/**
 * Regression for the analytics deep-link bug (/analytics?tab=posts landed on Overview,
 * with dead tab clicks). Root cause: useQueryState read the URL in its useState
 * initializer, so the server (no `window` -> default) and client (URL value) produced
 * different first renders. That hydration mismatch threw React error #418 and left the
 * island showing stale server markup with no event handlers attached.
 *
 * The hook must initialise to the DEFAULT on the first render (identical on server and
 * client), then adopt the real URL value in a post-mount effect.
 */

function setSearch(search: string) {
  window.history.replaceState({}, '', `/analytics${search}`);
}

function Probe({ recorded, paramKey, def }: { recorded: string[]; paramKey: string; def: string }) {
  const [v] = useQueryState(paramKey, def);
  recorded.push(v);
  return <span data-testid="v">{v}</span>;
}

describe('useQueryState', () => {
  beforeEach(() => setSearch(''));

  it('first render uses the default, then adopts the URL value after mount', () => {
    setSearch('?tab=posts');
    const recorded: string[] = [];
    const { getByTestId } = render(<Probe recorded={recorded} paramKey="tab" def="overview" />);
    // First committed render MUST equal the default — this is what keeps the server- and
    // client-rendered markup identical so hydration succeeds (no React #418).
    expect(recorded[0]).toBe('overview');
    // Once mounted on the client, the hook reflects the actual URL value.
    expect(getByTestId('v').textContent).toBe('posts');
  });

  it('uses the default when the query param is absent', () => {
    const recorded: string[] = [];
    const { getByTestId } = render(<Probe recorded={recorded} paramKey="tab" def="overview" />);
    expect(recorded[0]).toBe('overview');
    expect(getByTestId('v').textContent).toBe('overview');
  });

  it('setValue updates the value and the URL, and clears the param for the default', () => {
    let setter: (v: string) => void = () => {};
    function Ctl() {
      const [v, setV] = useQueryState<string>('tab', 'overview');
      setter = setV;
      return <span data-testid="v">{v}</span>;
    }
    const { getByTestId } = render(<Ctl />);

    act(() => setter('channels'));
    expect(getByTestId('v').textContent).toBe('channels');
    expect(new URL(window.location.href).searchParams.get('tab')).toBe('channels');

    // Setting the value back to the default removes the param entirely.
    act(() => setter('overview'));
    expect(new URL(window.location.href).searchParams.get('tab')).toBeNull();
  });
});
