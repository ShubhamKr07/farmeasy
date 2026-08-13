import React from "react";
import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Custom render wrapper for tests that use React Query hooks.
 *
 * Components using usePostAuthEvent, useGetMetricsAvailability, or other
 * React Query hooks require a QueryClientProvider wrapper. This wrapper
 * provides a fresh QueryClient per test with reasonable defaults.
 *
 * Usage: replace `render(...)` with `renderWithQueryClient(...)`
 */
export function renderWithQueryClient(
  ui: React.ReactElement,
  options?: RenderOptions,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
    ...options,
  });
}

// Re-export everything from @testing-library/react for convenience.
export * from "@testing-library/react";
