'use client';

import { useEffect, useState } from 'react';
import type { Asset } from '@kanso/schema';
import type { BasketEntry } from '@/features/basket/holding';
import { deployment } from '@/lib/kanso';

const key = `kanso:basket:${deployment.deployment_id}`;

export function useBasket(assets: Asset[] | undefined) {
  const [entries, setEntries] = useState<BasketEntry[]>([]);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!assets || restored) return;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (Array.isArray(saved)) {
        const seen = new Set<string>();
        setEntries(
          saved.flatMap((row) => {
            if (
              !row ||
              typeof row.asset_id !== 'string' ||
              typeof row.amount !== 'string' ||
              row.amount.length > 80 ||
              seen.has(row.asset_id)
            )
              return [];
            const asset = assets.find(
              (a) => a.asset_id === row.asset_id && a.enabled,
            );
            if (!asset) return [];
            seen.add(asset.asset_id);
            return [{ asset, amount: row.amount }];
          }),
        );
      }
    } catch {
      setEntries([]);
    }
    setRestored(true);
  }, [assets, restored]);
  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify(
          entries.map((e) => ({
            asset_id: e.asset.asset_id,
            amount: e.amount,
          })),
        ),
      );
    } catch {
      /* The current basket remains usable when local storage is unavailable. */
    }
  }, [entries, restored]);
  return { entries, setEntries };
}
