'use client';

import { useState } from 'react';
import { NetworkCard } from '@/features/landing/networks/network-card';
import type { SupportedNetwork } from '@/lib/networks';
import styles from '@/features/landing/networks.module.css';

const filters = [
  { id: 'all', label: 'All' },
  { id: 'evm', label: 'EVM' },
  { id: 'other', label: 'Beyond EVM' },
] as const;

type NetworkFilter = (typeof filters)[number]['id'];

function matchesFilter(network: SupportedNetwork, filter: NetworkFilter) {
  return (
    filter === 'all' ||
    (filter === 'evm' ? network.family === 'evm' : network.family !== 'evm')
  );
}

export function Networks({
  networks,
}: {
  networks: readonly SupportedNetwork[];
}) {
  const [filter, setFilter] = useState<NetworkFilter>('all');
  const visible = networks.filter((network) => matchesFilter(network, filter));

  return (
    <section
      id="networks"
      className={`container ${styles.section}`}
      aria-labelledby="networks-title"
    >
      <h2 id="networks-title" className={`section-heading ${styles.heading}`}>
        Right where
        <br />
        your assets are.
      </h2>
      <div
        className={styles.filters}
        role="group"
        aria-label="Filter supported chains"
      >
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            aria-controls="network-list"
            onClick={() => setFilter(item.id)}
          >
            {item.label}
            <span>
              {
                networks.filter((network) => matchesFilter(network, item.id))
                  .length
              }
            </span>
          </button>
        ))}
      </div>
      <p className="sr-only" role="status">
        Showing {visible.length}{' '}
        {filter === 'all' ? '' : filter === 'evm' ? 'EVM ' : 'non-EVM '}networks
      </p>
      <ul id="network-list" className={styles.grid}>
        {visible.map((network) => (
          <NetworkCard key={network.id} network={network} />
        ))}
      </ul>
    </section>
  );
}
