import bs58 from 'bs58';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import { secp256k1 } from '@noble/curves/secp256k1';
import { chain_manifest, deployment, loan_offer } from '@kanso/schema';
import type { ChainManifest, Deployment, Offer } from '@kanso/schema';
import { digest, Release } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import type { MpcKeys } from '@testnet/mpc';
import {
  evm_networks,
  NEAR_RPC,
  SOLANA_RPC,
  STARKNET_RPC,
  STRK,
  rpc,
} from '@testnet/network';
import { near_signer, near_send, near_view, call } from '@testnet/deploy-near';
import { RpcProvider } from '@server/shared/near/rpc.provider';
import { reference_assets, publish_live_prices } from '@testnet/live-oracle';

const NEAR = 10n ** 24n;
const bytes = (hex: string) =>
  Array.from(Buffer.from(hex.replace(/^0x/, '').padStart(64, '0'), 'hex'));
const evm_bytes = (hex: string) =>
  Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
export const asset_ids: Record<string, string> = {
  base: 'base_eth',
  arbitrum: 'arbitrum_eth',
  bnb: 'bnb',
  polygon: 'pol',
  avalanche: 'avax',
  hyperevm: 'hype',
  solana: 'sol',
  sui: 'sui',
  starknet: 'strk',
  bitcoin: 'btc',
};
export interface LivePlan {
  deployment: Deployment;
  policy: Record<string, unknown>;
  offers: Offer[];
  created_at: string;
}
export async function live_plan(release: Release): Promise<LivePlan> {
  const existing = release.journal.contracts.plan as LivePlan | undefined;
  if (existing) {
    const config = await near_view<{ settlement_token: string }>(
      existing.deployment.near.coordinator,
      'get_config',
    );
    if (config.settlement_token !== existing.deployment.near.settlement_token)
      throw new Error(
        'This historical verification plan uses a retired token; use live-api with the current runtime',
      );
    existing.deployment.near.rpc_url = NEAR_RPC;
    for (const offer of existing.offers)
      for (const leg of offer.legs)
        if (
          leg.custody.family === 'remote' &&
          leg.custody.chain_id === 'starknet'
        )
          leg.custody.lock_id[0] = leg.custody.lock_id[0]! & 3;
    await release.save();
    return existing;
  }
  const primary = await read_json<{
    contracts: Record<string, Record<string, unknown>>;
  }>(release.folder, 'deployment.json');
  const mpc = await read_json<MpcKeys>(release.folder, 'mpc.json');
  const borrower = await near_signer(release, 'borrower'),
    coordinator = await near_signer(release, 'coordinator');
  const chain_names: Record<number, string> = {
    84532: 'base',
    421614: 'arbitrum',
    97: 'bnb',
    80002: 'polygon',
    43113: 'avalanche',
    998: 'hyperevm',
  };
  const configurations = [];
  const evidence_hash = bytes(
    digest(
      JSON.stringify({
        deployed: primary.contracts,
        mpc,
        stage:
          'immutable deployments and live MPC provider mappings; full lifecycle verification in progress',
      }),
    ),
  );
  function manifest(
    chain_id: string,
    family: ChainManifest['family'],
    vault: number[],
    controller: number[],
    network_fingerprint: string,
    decimals: number,
    extra: Partial<ChainManifest> = {},
  ) {
    const key = mpc.controllers[chain_id]!;
    return chain_manifest.parse({
      chain_id,
      version: 1,
      family,
      vault,
      controller,
      network_fingerprint,
      decimals,
      controller_public_key: evm_bytes(key.public_key),
      asset_id: asset_ids[chain_id],
      asset_address: [],
      max_collateral_atomic: (10n ** BigInt(decimals + 3)).toString(),
      ltv_bps: 5000,
      liquidation_threshold_bps: 7000,
      mpc_account: mpc.account,
      read_domain: mpc.read_domain,
      read_public_key: evm_bytes(mpc.read_public_key),
      sign_domain: key.domain,
      derivation_path: key.path,
      minimum_confirmations: 1,
      initial_account_nonce: 0,
      max_gas: 250000,
      max_fee_per_gas: '100000000000',
      max_network_cost_atomic: '75000000000000000',
      capability_evidence_hash: evidence_hash,
      new_locks_enabled: true,
      signing_enabled: true,
      ...extra,
    });
  }
  for (const chain of evm_networks) {
    const name = chain_names[chain.id]!,
      contract = primary.contracts[name]!;
    const gas =
      BigInt(
        await rpc<string>(chain.rpcUrls.default.http[0], 'eth_gasPrice', []),
      ) * 4n;
    configurations.push({
      manifest: manifest(
        name,
        'evm',
        evm_bytes(String(contract.address)),
        evm_bytes(mpc.controllers[name]!.address!),
        String(chain.id),
        18,
        {
          max_fee_per_gas: gas.toString(),
          max_network_cost_atomic: (gas * 750000n).toString(),
        },
      ),
      rpc_url: chain.rpcUrls.default.http[0],
      evidence: null,
    });
  }
  const sol = (
    await read_json<{
      contracts: {
        solana: {
          program: string;
          config: string;
          network_fingerprint: string;
        };
      };
    }>(release.folder, 'deployment-solana.json')
  ).contracts.solana;
  configurations.push({
    manifest: manifest(
      'solana',
      'solana',
      [...bs58.decode(sol.program), ...bs58.decode(sol.config)],
      Array.from(bs58.decode(mpc.controllers.solana!.address!)),
      sol.network_fingerprint,
      9,
      {
        max_gas: 200000,
        max_fee_per_gas: '1000000',
        max_network_cost_atomic: '5000000',
      },
    ),
    rpc_url: SOLANA_RPC,
    evidence: null,
  });
  const sui = (
    await read_json<{
      contracts: {
        sui: { package: string; vault: string; network_fingerprint: string };
      };
    }>(release.folder, 'deployment-sui.json')
  ).contracts.sui;
  configurations.push({
    manifest: manifest(
      'sui',
      'sui',
      [...bytes(sui.package), ...bytes(sui.vault)],
      bytes(mpc.controllers.sui!.address!),
      sui.network_fingerprint,
      9,
      {
        max_gas: 100000000,
        max_fee_per_gas: '100000',
        max_network_cost_atomic: '50000000',
      },
    ),
    rpc_url: 'https://fullnode.testnet.sui.io:443',
    evidence: null,
  });
  const stark = (
    await read_json<{
      contracts: { starknet: { vault: string; controller: string } };
    }>(release.folder, 'deployment-starknet.json')
  ).contracts.starknet;
  configurations.push({
    manifest: manifest(
      'starknet',
      'starknet',
      bytes(stark.vault),
      bytes(stark.controller),
      'SN_SEPOLIA',
      18,
      {
        asset_address: bytes(STRK),
        max_gas: 100000000,
        max_fee_per_gas: '1000000000000000',
        max_network_cost_atomic: '9000000000000000000',
      },
    ),
    rpc_url: STARKNET_RPC,
    evidence: null,
  });
  const btc_key = Array.from(
    secp256k1.ProjectivePoint.fromHex(
      '04' + mpc.controllers.bitcoin!.public_key,
    ).toRawBytes(true),
  );
  const bitcoin_rpc = 'https://bitcoin-testnet-rpc.publicnode.com';
  const genesis =
    '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943';
  const bitcoin_configuration = {
    manifest: manifest('bitcoin', 'bitcoin', [], btc_key, genesis, 8, {
      controller_public_key: btc_key,
      max_gas: 1000,
      max_fee_per_gas: '100',
      max_network_cost_atomic: '1000',
    }),
    rpc_url: bitcoin_rpc,
    evidence: null,
  };
  if (
    (await new RpcProvider(process.env)
      .client(bitcoin_configuration)
      .call<string>('getblockhash', [0])) !== genesis
  )
    throw new Error('Bitcoin RPC is not Testnet3');
  configurations.push(bitcoin_configuration);
  const d = deployment.parse({
    deployment_id: release.journal.deployment_id,
    network: 'testnet',
    near: {
      rpc_url: NEAR_RPC,
      coordinator: coordinator.accountId,
      settlement_token: NEAR_TESTNET_USDC,
      settlement_decimals: 6,
      max_mpc_deposit_atomic: '1',
    },
    pool_ids: ['live-verification'],
    chains: configurations,
  });
  const policy = {
    version: 1,
    apr_bps: 1000,
    origination_fee_atomic: '0',
    min_principal_atomic: '1',
    max_principal_atomic: '10000000',
    max_duration_seconds: 2592000,
    setup_duration_seconds: 86400,
    grace_seconds: 1,
    interest_buffer_seconds: 86400,
    ltv_bps: 5000,
    liquidation_threshold_bps: 7000,
    min_liquidity_atomic: '0',
    withdrawal_health_ppm: 1200000,
    min_conditional_trigger_health_ppm: 1100000,
    max_liquidation_surplus_atomic: '1000000',
    recovery_health_ppm: 1300000,
    max_execution_cost_bps: 9000,
    max_slippage_bps: 1000,
    max_execution_cost_atomic: '10000000',
    eligible_assets: Object.keys(reference_assets),
    asset_caps: Object.keys(reference_assets).map((asset_id) => ({
      asset_id,
      max_collateral_value_atomic: '1000000000000',
    })),
    max_outstanding_principal_atomic: '50000000',
  };
  const now = Math.floor(Date.now() / 1000);
  const evm = await read_json<{ address: string }>(
      release.folder,
      'keys/evm-deployer.json',
    ),
    sol_owner = await read_json<number[]>(
      release.folder,
      'keys/solana-deployer.json',
    ),
    sui_owner = await read_json<{ address: string }>(
      release.folder,
      'keys/sui-deployer.json',
    ),
    stark_owner = await read_json<{ address: string }>(
      release.folder,
      'keys/starknet-deployer.json',
    ),
    btc_owner = await read_json<{ public_key: string }>(
      release.folder,
      'keys/bitcoin-deployer.json',
    );
  const { payments, networks } = await import('bitcoinjs-lib');
  const btc_script = Array.from(
    payments.p2wpkh({
      pubkey: Buffer.from(btc_owner.public_key, 'hex'),
      network: networks.testnet,
    }).output!,
  );
  const { Keypair } = await import('@solana/web3.js');
  const offers: Offer[] = [];
  for (const chain_id of [
    'near',
    ...configurations.map((c) => c.manifest.chain_id),
  ]) {
    const c = d.chains.find((c) => c.manifest.chain_id === chain_id);
    const asset_id = c?.manifest.asset_id ?? 'near';
    const price = await near_view<{
      price_atomic: string;
      published_at: number;
    } | null>(coordinator.accountId, 'get_asset_price', { asset_id });
    if (!price || now - price.published_at > 300)
      throw new Error(`Refresh oracle before preparing offers: ${asset_id}`);
    const principal =
      chain_id === 'bitcoin'
        ? 5_000_000n
        : chain_id === 'near'
          ? 1_000_000n
          : 100n;
    const scale = 10n ** BigInt(c?.manifest.decimals ?? 24);
    const amount =
      (principal * 6n * scale + BigInt(price.price_atomic) - 1n) /
      BigInt(price.price_atomic);
    const source =
      chain_id === 'solana'
        ? Array.from(
            Keypair.fromSecretKey(
              Uint8Array.from(sol_owner),
            ).publicKey.toBytes(),
          )
        : chain_id === 'sui'
          ? bytes(sui_owner.address)
          : chain_id === 'starknet'
            ? bytes(stark_owner.address)
            : chain_id === 'bitcoin'
              ? btc_script
              : evm_bytes(evm.address);
    for (const kind of ['repay', 'liquidate']) {
      const offer_id = `live_${chain_id}_${kind}_v1`;
      offers.push(
        loan_offer.parse({
          deployment_id: d.deployment_id,
          network: 'testnet',
          offer_id,
          pool_id: 'live-verification',
          borrower: borrower.accountId,
          payout_account: borrower.accountId,
          policy_version: 1,
          principal_atomic: principal.toString(),
          apr_bps: policy.apr_bps,
          duration_seconds: kind === 'liquidate' ? 1 : 86400,
          origination_fee_atomic: '0',
          expires_at: now + 3600,
          setup_deadline: now + 86000,
          min_price_atomic: '1',
          max_price_atomic: (BigInt(price.price_atomic) * 10n).toString(),
          legs: [
            {
              asset_id,
              leg_id: chain_id,
              owner: borrower.accountId,
              amount_atomic: amount.toString(),
              release_recipient: borrower.accountId,
              custody: c
                ? {
                    family: 'remote',
                    chain_id,
                    manifest_version: 1,
                    lock_id: bytes(digest(offer_id)).map((v, i) =>
                      chain_id === 'starknet' && i === 0 ? v & 3 : v,
                    ),
                    source_owner: source,
                    release_recipient: source,
                    min_price_atomic: '1',
                    max_price_atomic: (
                      BigInt(price.price_atomic) * 10n
                    ).toString(),
                  }
                : { family: 'near' },
            },
          ],
        }),
      );
    }
  }
  const plan = {
    deployment: d,
    policy,
    offers,
    created_at: new Date().toISOString(),
  };
  release.journal.contracts.plan = plan;
  await release.save();
  return plan;
}
export async function setup_live(release: Release) {
  const oracle = await Release.load('deployment-oracle.json');
  await oracle.lock(() => publish_live_prices(oracle));
  const plan = await live_plan(release),
    d = plan.deployment;
  const owner = await near_signer(release, 'owner'),
    manager = await near_signer(release, 'manager'),
    lp = await near_signer(release, 'lp');
  for (const [role, amount] of [
    ['owner', NEAR / 2n],
    ['borrower', 3n * NEAR],
    ['solver', 2n * NEAR],
    ['relayer', NEAR / 2n],
  ] as const) {
    const signer = await near_signer(release, role);
    await near_send(
      release,
      `live-storage-${role}`,
      signer,
      d.near.coordinator,
      [call('storage_deposit', {}, amount)],
    );
  }
  for (const c of d.chains) {
    await near_send(
      release,
      `manifest-${c.manifest.chain_id}`,
      owner,
      d.near.coordinator,
      [call('register_chain_manifest', { manifest: c.manifest })],
    );
    const effect = await near_send(
      release,
      `controller-key-${c.manifest.chain_id}`,
      owner,
      d.near.coordinator,
      [
        call('verify_controller_key', {
          chain_id: c.manifest.chain_id,
          version: 1,
        }),
      ],
    );
    const result = effect.result as { status: { SuccessValue: string } };
    if (
      JSON.parse(
        Buffer.from(result.status.SuccessValue, 'base64').toString(),
      ) !== true
    )
      throw new Error('Controller verification callback did not succeed');
  }
  await near_send(release, 'live-pool-create', manager, d.near.coordinator, [
    call('create_pool', { pool_id: 'live-verification', policy: plan.policy }),
  ]);
  await near_send(release, 'live-pool-fund', lp, d.near.settlement_token, [
    call('ft_transfer_call', {
      receiver_id: d.near.coordinator,
      amount: '50000000',
      msg: JSON.stringify({
        kind: 'pool_deposit',
        pool_id: 'live-verification',
        operation_id: 'live_pool_fund_v1',
      }),
    }),
  ]);
  const pool = await near_view<{ cash_atomic: string }>(
    d.near.coordinator,
    'get_pool',
    { pool_id: 'live-verification' },
  );
  if (BigInt(pool.cash_atomic) < 50_000_000n)
    throw new Error('Live verification pool was not funded');
  console.log(
    'Live manifests and derived controllers verified; verification pool funded; origination remains paused',
  );
}
