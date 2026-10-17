'use client';

import { useState } from 'react';
import { Button } from './ui';

/** Shows a secret that will never be displayed again, with a copy button. */
export function CopySecret({
  label,
  value,
  onDone,
}: {
  label: string;
  value: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      role="alert"
      className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:ring-amber-900"
    >
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">{label}</p>
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
        Copy it now. For security it is stored only as a hash or encrypted, and won’t be shown
        again.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="rounded bg-white px-2 py-1 font-mono text-xs break-all ring-1 ring-amber-200 dark:bg-slate-900 dark:ring-amber-900">
          {value}
        </code>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
