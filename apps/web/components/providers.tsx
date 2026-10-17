'use client';

import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { ToastProvider } from './toast';

export function Providers({ children }: { children: ReactNode }) {
  // Created once per browser tab (useState), not on every render.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            // Don't retry 4xx errors: they won't fix themselves.
            retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
          },
        },
        // A 401 anywhere means the session expired: go to the login page.
        queryCache: new QueryCache({
          onError: (err) => {
            if (
              err instanceof ApiError &&
              err.status === 401 &&
              !location.pathname.startsWith('/login')
            ) {
              location.assign('/login');
            }
          },
        }),
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
