import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Providers } from '@/components/layout/providers';
import { Workspace } from '@/features/workspace/workspace';

export const metadata: Metadata = { title: 'Kanso — Borrow USDC' };

export default function AppPage() {
  return (
    <Providers>
      <Suspense>
        <Workspace />
      </Suspense>
    </Providers>
  );
}
