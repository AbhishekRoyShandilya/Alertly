'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useLogout, useMe } from '@/lib/hooks';
import { cx } from './ui';

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/channels', label: 'Channels' },
  { href: '/alerts', label: 'Alerts' },
  { href: '/notifications', label: 'Notifications' },
  { href: '/deliveries', label: 'Deliveries' },
  { href: '/api-keys', label: 'API keys' },
  { href: '/docs', label: 'API docs' },
];

/** Sidebar layout for signed-in pages; collapses to a top bar with a menu on phones. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const logout = useLogout();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          onClick={() => setOpen(false)}
          aria-current={isActive(n.href) ? 'page' : undefined}
          className={cx(
            'rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            isActive(n.href)
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-brand-100'
              : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800',
          )}
        >
          {n.label}
        </Link>
      ))}
    </nav>
  );

  const account = (
    <div className="border-t border-slate-200 pt-4 text-sm dark:border-slate-800">
      <p className="truncate text-slate-500" title={me.data?.user.email}>
        {me.data?.user.email ?? ' '}
      </p>
      <button
        className="mt-1 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
        onClick={() => logout.mutate(undefined, { onSettled: () => router.replace('/login') })}
      >
        Log out
      </button>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-slate-200 bg-white p-4 lg:flex dark:border-slate-800 dark:bg-slate-900">
        <div>
          <Logo />
          <div className="mt-6">{nav}</div>
        </div>
        {account}
      </aside>

      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden dark:border-slate-800 dark:bg-slate-900">
        <Logo />
        <button
          aria-expanded={open}
          aria-label="Menu"
          onClick={() => setOpen((o) => !o)}
          className="rounded-lg px-3 py-1.5 text-sm ring-1 ring-slate-300 dark:ring-slate-700"
        >
          Menu
        </button>
      </header>
      {open && (
        <div className="space-y-4 border-b border-slate-200 bg-white p-4 lg:hidden dark:border-slate-800 dark:bg-slate-900">
          {nav}
          {account}
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-8">{children}</main>
    </div>
  );
}

export const Logo = () => (
  <Link href="/" className="flex items-center gap-2 font-semibold">
    <span className="grid size-7 place-items-center rounded-lg bg-brand-600 text-sm text-white">
      A
    </span>
    Alertly
  </Link>
);
