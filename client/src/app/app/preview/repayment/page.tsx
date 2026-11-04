import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const metadata: Metadata = {
  title: 'Kanso — Repayment preview',
  robots: { index: false, follow: false },
};

export default async function RepaymentPreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  const { RepaymentPreview } = await import('@/features/repayment/preview');
  return <RepaymentPreview />;
}
