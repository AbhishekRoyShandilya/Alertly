import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui';

export const metadata: Metadata = { title: 'API docs' };

// A server component: static content, no client JavaScript needed.

const CURL = `curl -X POST "$ALERTLY_URL/api/v1/notifications" \\
  -H "Authorization: Bearer $ALERTLY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: deploy-2026-10-16-1" \\
  -d '{"title":"Deploy finished","body":"v1.4.2 is live","priority":"normal"}'`;

const NODE = `const res = await fetch(\`\${process.env.ALERTLY_URL}/api/v1/notifications\`, {
  method: 'POST',
  headers: {
    Authorization: \`Bearer \${process.env.ALERTLY_API_KEY}\`,
    'Content-Type': 'application/json',
    // Retrying with the same key never creates a duplicate notification.
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({ title: 'Disk almost full', body: 'server-3 at 92%', data: { pct: 92 } }),
});
console.log(res.status, await res.json()); // 201 Created`;

const VERIFY = `import { createHmac, timingSafeEqual } from 'node:crypto';

// header: "t=1760612345,v1=5f2b…"  rawBody: the exact request body string
export function verifyAlertly(secret, header, rawBody, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // replay protection
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}`;

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-relaxed text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

export default function DocsPage() {
  return (
    <>
      <PageHeader
        title="API docs"
        description="Send notifications from any program with an API key."
      />
      <div className="space-y-6">
        <Card>
          <h2 className="font-medium">Full reference</h2>
          <p className="mt-1 text-sm text-slate-500">
            Every endpoint, generated from the same schemas the API validates with.
          </p>
          <a
            href={`${process.env.NEXT_PUBLIC_API_DOCS_URL ?? 'http://localhost:4000'}/docs`}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
          >
            Open Swagger UI →
          </a>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-medium">Send a notification (curl)</h2>
          <Code>{CURL}</Code>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-medium">Send a notification (Node.js)</h2>
          <Code>{NODE}</Code>
        </Card>
        <Card className="space-y-3">
          <h2 className="font-medium">Verify webhook signatures</h2>
          <p className="text-sm text-slate-500">
            Every webhook carries <code>X-Alertly-Signature</code> and{' '}
            <code>X-Alertly-Notification-Id</code>. Verify the signature, and use the notification
            id to ignore duplicates (delivery is at-least-once).
          </p>
          <Code>{VERIFY}</Code>
        </Card>
      </div>
    </>
  );
}
