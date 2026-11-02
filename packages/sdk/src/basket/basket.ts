import bs58 from 'bs58';
import { address, networks } from 'bitcoinjs-lib';
import { basket_leg, KansoError, mul_div_floor } from '@kanso/schema';
import type { BasketLeg, ChainFamily } from '@kanso/schema';
import type { Context } from '@sdk/client/context';
import type { AssetInput } from '@sdk/types/client.types';
import { scoped_id, from_hex } from '@sdk/transport/codec';
import { executable_chain } from '@kanso/bindings';
export function account_bytes(family: ChainFamily, value: string): number[] {
  if (family === 'bitcoin')
    return Array.from(address.toOutputScript(value, networks.testnet));
  if (family === 'solana') return Array.from(bs58.decode(value));
  const width = family === 'evm' ? 40 : 64;
  const hex = value.replace(/^0x/, '');
  if (
    hex.length > width ||
    !/^([a-f0-9])+$/i.test(hex) ||
    (family === 'evm' && hex.length !== 40)
  )
    throw new KansoError('INVALID_INPUT', 'Invalid source account');
  return Array.from(from_hex(hex.padStart(width, '0')));
}
export async function build_leg(
  c: Context,
  input: AssetInput,
  owner: string,
  leg_id: string,
  lock_seed: string,
): Promise<BasketLeg> {
  if (input.asset_id === 'near') {
    if (input.source_account && input.source_account !== owner)
      throw new KansoError(
        'FORBIDDEN',
        'NEAR collateral must belong to the borrower',
      );
    return basket_leg.parse({
      asset_id: 'near',
      custody: { family: 'near' },
      leg_id,
      owner,
      amount_atomic: input.amount_atomic,
      release_recipient: input.refund_account ?? owner,
    });
  }
  const configured = c.deployment.chains.find(
    (x) => x.manifest.asset_id === input.asset_id,
  );
  if (!configured)
    throw new KansoError('CAPABILITY_DISABLED', 'Asset is not configured');
  const chain = executable_chain(c.deployment, configured.manifest.chain_id),
    m = chain.manifest;
  const wallet = await c.wallets.get(
    m.family,
    m.chain_id,
    input.source_account,
  );
  const accounts = await wallet.accounts();
  const source = accounts.find(
    (x) =>
      x.chain_id === m.chain_id &&
      (!input.source_account || x.address === input.source_account),
  );
  if (!source)
    throw new KansoError(
      'WALLET_REQUIRED',
      'Source wallet has no selected account',
    );
  await c.session.link(m.family, m.chain_id, source.address);
  const price = await c.coordinator.view('get_asset_price', {
    asset_id: m.asset_id,
  });
  if (!price) throw new KansoError('PRICE_STALE', 'No published asset price');
  const value = mul_div_floor(
    BigInt(price.price_atomic),
    BigInt(10000 - price.confidence_bps),
    10000n,
  );
  if (value === 0n)
    throw new KansoError('PRICE_STALE', 'Conservative price is zero');
  const lock_id = Array.from(from_hex(scoped_id(lock_seed, leg_id)));
  if (m.family === 'starknet') lock_id[0] = lock_id[0]! & 3;
  return basket_leg.parse({
    asset_id: input.asset_id,
    custody: {
      family: 'remote',
      chain_id: m.chain_id,
      manifest_version: m.version,
      lock_id,
      source_owner: account_bytes(m.family, source.address),
      release_recipient: account_bytes(
        m.family,
        input.refund_account ?? source.address,
      ),
      min_price_atomic: ((value * 99n) / 100n || 1n).toString(),
      max_price_atomic: ((value * 101n) / 100n + 1n).toString(),
    },
    leg_id,
    owner,
    amount_atomic: input.amount_atomic,
    release_recipient: owner,
  });
}

export function canonical_account(family: ChainFamily, value: string): string {
  if (family === 'near') return value;
  if (family === 'solana') {
    const bytes = account_bytes(family, value);
    if (bytes.length !== 32)
      throw new KansoError('INVALID_INPUT', 'Invalid Solana account');
    return bs58.encode(Uint8Array.from(bytes));
  }
  if (family === 'bitcoin')
    return address.fromOutputScript(
      Uint8Array.from(account_bytes(family, value)),
      networks.testnet,
    );
  return (
    '0x' +
    Array.from(account_bytes(family, value), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('')
  );
}
