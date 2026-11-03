import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/dm-sans';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'Kanso — Your assets, together',
  description:
    'Merge assets across wallets and chains into one collateral basket and borrow USDC. Explore Kanso on testnet.',
  applicationName: 'Kanso',
  openGraph: {
    title: 'Kanso — Your assets, together',
    description:
      'Merge assets across chains into one collateral basket and borrow USDC.',
    type: 'website',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
