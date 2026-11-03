'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { Asset, ChainFamily } from '@kanso/schema';
import type { Kanso } from '@kanso/sdk';
import { Wallet } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { createClient } from '@/lib/kanso';
import { walletChoices } from '@/lib/wallets';
import { familyNames } from '@/lib/wallets/types';
import type { ConnectedWallet, WalletChoice } from '@/lib/wallets/types';
import { errorMessage } from '@/lib/amounts';
import styles from '@/features/workspace/workspace.module.css';

export type PoolSummary = Awaited<
  ReturnType<ReturnType<Kanso['pool']>['summary']>
>;
type Catalog = { assets: Asset[]; pools: PoolSummary[] };
type AppContext = {
  client: Kanso;
  catalog: Catalog | null;
  catalogError: string | null;
  loading: boolean;
  connections: ConnectedWallet[];
  account: string | null;
  connecting: boolean;
  connect: (family?: ChainFamily) => Promise<ConnectedWallet>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
};
const Context = createContext<AppContext | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const wallets = useRef(new Map<ChainFamily, ConnectedWallet>());
  const pending = useRef<{
    resolve: (wallet: ConnectedWallet) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const [connections, setConnections] = useState<ConnectedWallet[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [selection, setSelection] = useState<{
    family: ChainFamily;
    choices: WalletChoice[];
  } | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function connect(
    family: ChainFamily = 'near',
  ): Promise<ConnectedWallet> {
    const existing = wallets.current.get(family);
    if (existing) return existing;
    setWalletError(null);
    if (family !== 'near') {
      const choices = await walletChoices(family);
      return new Promise((resolve, reject) => {
        pending.current = { resolve, reject };
        setSelection({ family, choices });
      });
    }
    setConnecting(true);
    try {
      const wallet = await (await import('@/lib/wallets/near')).connectNear();
      wallets.current.set(family, wallet);
      setConnections([...wallets.current.values()]);
      return wallet;
    } finally {
      setConnecting(false);
    }
  }

  const [client] = useState(() =>
    createClient(async ({ family }) => (await connect(family)).port),
  );

  async function refresh() {
    setLoading(true);
    setCatalogError(null);
    try {
      const [assets, pools] = await Promise.all([
        client.catalog.assets(),
        client.catalog.pools(),
      ]);
      const summaries = await Promise.all(
        pools.map((p) => client.pool(p.pool_id).summary()),
      );
      setCatalog({ assets, pools: summaries });
    } catch (error) {
      setCatalog(null);
      setCatalogError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [client]);
  useEffect(
    () => () => pending.current?.reject(new Error('Wallet connection closed.')),
    [],
  );

  async function disconnect() {
    client.session.disconnect();
    const current = [...wallets.current.values()];
    wallets.current.clear();
    setConnections([]);
    await Promise.allSettled(current.map((w) => w.disconnect?.()));
  }

  async function choose(choice: WalletChoice) {
    const currentSelection = selection;
    flushSync(() => setSelection(null));
    setConnecting(true);
    setWalletError(null);
    try {
      const wallet = await choice.connect();
      wallets.current.set(wallet.family, wallet);
      setConnections([...wallets.current.values()]);
      pending.current?.resolve(wallet);
      pending.current = null;
      setSelection(null);
    } catch (error) {
      setSelection(currentSelection);
      setWalletError(errorMessage(error));
    } finally {
      setConnecting(false);
    }
  }

  function closeSelection() {
    if (connecting) return;
    pending.current?.reject(new Error('Wallet connection cancelled.'));
    pending.current = null;
    setSelection(null);
  }

  return (
    <Context.Provider
      value={{
        client,
        catalog,
        catalogError,
        loading,
        connections,
        account: connections.find((w) => w.family === 'near')?.address ?? null,
        connecting,
        connect,
        disconnect,
        refresh,
      }}
    >
      {children}
      {selection && (
        <Dialog
          title={`Connect ${familyNames[selection.family]}`}
          onClose={closeSelection}
        >
          <p className={styles.muted}>
            Choose a wallet for your {familyNames[selection.family]} assets.
          </p>
          <div className={styles.walletOptions}>
            {selection.choices.map((choice) => (
              <button
                type="button"
                key={choice.id}
                disabled={connecting}
                onClick={() => void choose(choice)}
              >
                <Wallet size={20} />
                <span>{choice.name}</span>
              </button>
            ))}
            {!selection.choices.length && (
              <p className={styles.notice}>
                No compatible wallet was detected. Install a compatible wallet
                for {familyNames[selection.family]} with message and transaction
                signing, then reopen this dialog.
              </p>
            )}
          </div>
          {walletError && (
            <p className={styles.error} role="alert">
              {walletError}
            </p>
          )}
        </Dialog>
      )}
    </Context.Provider>
  );
}

export function useKanso() {
  const value = useContext(Context);
  if (!value) throw new Error('Kanso components require Providers.');
  return value;
}
