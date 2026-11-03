'use client';

import { useState } from 'react';
import { Check, Plus, Search } from 'lucide-react';
import type { Asset } from '@kanso/schema';
import { Dialog } from '@/components/ui/dialog';
import { AssetIdentity } from '@/features/basket/holding';
import ui from '@/features/workspace/workspace.module.css';
import styles from '@/features/basket/basket.module.css';

export function BasketPicker({
  assets,
  selected,
  onApply,
  onClose,
}: {
  assets: Asset[];
  selected: string[];
  onApply: (assets: Asset[]) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState(new Set(selected));
  const visible = assets.filter((asset) =>
    `${asset.symbol} ${asset.chain_id}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <Dialog title="Choose your assets" onClose={onClose}>
      <div className={styles.search}>
        <Search size={18} />
        <input
          autoComplete="off"
          aria-label="Search assets or chains"
          placeholder="Search assets or chains"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className={styles.assetList}>
        {visible.map((asset) => (
          <button
            key={asset.asset_id}
            type="button"
            className={styles.assetChoice}
            aria-pressed={chosen.has(asset.asset_id)}
            disabled={!asset.enabled}
            title={asset.reason ?? undefined}
            onClick={() =>
              setChosen((previous) => {
                const next = new Set(previous);
                if (next.has(asset.asset_id)) next.delete(asset.asset_id);
                else next.add(asset.asset_id);
                return next;
              })
            }
          >
            <AssetIdentity asset={asset} />
            {!asset.enabled ? (
              <span className={styles.paused}>Unavailable</span>
            ) : chosen.has(asset.asset_id) ? (
              <Check size={19} />
            ) : (
              <Plus size={19} />
            )}
          </button>
        ))}
        {!visible.length && (
          <p className={ui.notice}>No matching assets or chains.</p>
        )}
      </div>
      <button
        type="button"
        className={`${ui.primary} ${ui.full}`}
        onClick={() => {
          onApply(assets.filter((asset) => chosen.has(asset.asset_id)));
          onClose();
        }}
      >
        Use {chosen.size || 'no'} {chosen.size === 1 ? 'asset' : 'assets'}
      </button>
    </Dialog>
  );
}
