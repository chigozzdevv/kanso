import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Wordmark } from '@/components/layout/wordmark';

export default function NotFound() {
  return (
    <main className="not-found">
      <Wordmark />
      <p className="eyebrow">404</p>
      <h1>A little off-chain.</h1>
      <p>We couldn’t find that page.</p>
      <Link className="button button-primary" href="/">
        <ArrowLeft size={18} aria-hidden="true" />
        Back to Kanso
      </Link>
    </main>
  );
}
