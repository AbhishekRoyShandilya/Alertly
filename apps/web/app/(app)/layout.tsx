import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';

// Every signed-in page shares the sidebar. The "(app)" folder groups routes without adding
// a URL segment: /channels, not /app/channels.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
