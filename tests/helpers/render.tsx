/**
 * Custom render that wraps components in an isolated SWR cache.
 * Prevents SWR deduplication and cache leaking between tests.
 */
import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { SWRConfig } from 'swr';

function SWRWrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, errorRetryCount: 0 }}>
      {children}
    </SWRConfig>
  );
}

export function renderWithSWR(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, { wrapper: SWRWrapper, ...options });
}
