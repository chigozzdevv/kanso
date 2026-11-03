import { generate_keys } from '@testnet/keys';
import { directory } from '@testnet/store';
import { fund_testnet, testnet_status } from '@testnet/faucets';
import { prepare_starknet } from '@testnet/starknet';
import { Release } from '@testnet/deployment';
import { deploy_near } from '@testnet/deploy-near';
import { upgrade_near } from '@testnet/upgrade-near';
import { migrate_settlement, settlement_status } from '@testnet/settlement';
import {
  circle_status,
  prepare_circle_funding,
  circle_deposit_address,
} from '@testnet/circle-mint';
import {
  circle_withdraw,
  circle_fund_targets,
  circle_deposit_near,
} from '@testnet/circle-funding';
import { configure_bitcoin } from '@testnet/configure-bitcoin';
import { verify_bitcoin_recovery } from '@testnet/live-bitcoin-recovery';
import { mpc_keys } from '@testnet/mpc';
import { deploy_evm } from '@testnet/deploy-evm';
import { deploy_sui } from '@testnet/deploy-sui';
import { deploy_starknet } from '@testnet/deploy-starknet';
import { deploy_solana } from '@testnet/deploy-solana';
import { configure_near } from '@testnet/configure-near';
import { deployment_record } from '@testnet/deployment-record';
import { probe_reads } from '@testnet/live-mpc';
import { publish_live_prices, watch_live_prices } from '@testnet/live-oracle';
import { setup_live } from '@testnet/live-setup';
import { fund_controllers } from '@testnet/live-gas';
import { settle_live, release_live } from '@testnet/live-settlement';
import { verify_unauthorized } from '@testnet/live-security';
import { verify_native_authority } from '@testnet/live-security-native';
import { live_report } from '@testnet/live-report';
import { verify_basket } from '@testnet/live-basket';
import { audit_live } from '@testnet/live-audit';
import { local_services } from '@testnet/local-services';
import { prepare_capabilities, activate_lending } from '@testnet/live-enable';
import { verify_wallet_auth } from '@testnet/live-wallet-auth';
import { verify_api_lifecycle, verify_settlement } from '@testnet/live-api';
import {
  accept_live,
  deposit_live,
  verify_locks,
  fund_live,
} from '@testnet/live-loans';
const command = process.argv[2];
if (command === 'circle-deposit-near') {
  const release = await Release.load('deployment-circle.json');
  await release.lock(async () =>
    console.log(
      JSON.stringify(
        await circle_deposit_near(
          release,
          process.argv[3] ?? '',
          process.argv[4] ?? '',
        ),
        null,
        2,
      ),
    ),
  );
} else if (command === 'circle-address') {
  const release = await Release.load('deployment-circle.json');
  await release.lock(async () =>
    console.log(
      JSON.stringify(
        await circle_deposit_address(release, process.argv[3] ?? ''),
        null,
        2,
      ),
    ),
  );
} else if (command === 'circle-withdraw' || command === 'circle-fund') {
  const release = await Release.load('deployment-circle.json');
  await release.lock(async () =>
    console.log(
      JSON.stringify(
        command === 'circle-withdraw'
          ? await circle_withdraw(
              release,
              process.argv[3] ?? '',
              process.argv[4] ?? '',
              process.argv[5] ?? '',
            )
          : await circle_fund_targets(
              release,
              process.argv[3] ?? '',
              process.argv[4] ?? '',
              process.argv[5] ?? '',
            ),
        null,
        2,
      ),
    ),
  );
} else if (command === 'circle-status') {
  console.log(JSON.stringify(await circle_status(), null, 2));
} else if (command === 'circle-prepare') {
  const release = await Release.load('deployment-circle.json');
  await release.lock(async () =>
    console.log(
      JSON.stringify(
        await prepare_circle_funding(
          release,
          process.argv[3] ?? '',
          process.argv[4] ?? '',
        ),
        null,
        2,
      ),
    ),
  );
} else if (command === 'keys') {
  const index = await generate_keys();
  console.log(
    JSON.stringify(
      {
        directory: await directory(),
        created_at: index.created_at,
        wallets: index.wallets,
      },
      null,
      2,
    ),
  );
} else if (command === 'status') {
  console.log(JSON.stringify(await testnet_status(), null, 2));
} else if (command === 'faucet')
  await fund_testnet(
    process.argv[3],
    process.argv.includes('--retry-unavailable'),
  );
else if (command === 'starknet-accounts')
  console.log(JSON.stringify(await prepare_starknet(), null, 2));
else if (command === 'deploy-near') {
  const release = await Release.load();
  await release.lock(async () =>
    console.log(JSON.stringify(await deploy_near(release), null, 2)),
  );
} else if (
  command === 'migrate-settlement' ||
  command === 'settlement-status'
) {
  const release = await Release.load('deployment-usdc.json');
  if (command === 'settlement-status')
    console.log(JSON.stringify(await settlement_status(release), null, 2));
  else await release.lock(() => migrate_settlement(release));
} else if (command === 'verify-settlement') {
  const release = await Release.load('deployment-usdc.json');
  await release.lock(() => verify_settlement(release));
} else if (command === 'upgrade-near') {
  const release = await Release.load();
  await release.lock(() => upgrade_near(release));
} else if (command === 'configure-bitcoin') {
  const release = await Release.load();
  await release.lock(() => configure_bitcoin(release));
} else if (command === 'live-bitcoin-recovery') {
  const release = await Release.load('deployment-verification.json');
  await release.lock(() =>
    verify_bitcoin_recovery(release, process.argv[3], process.argv[4]),
  );
} else if (command === 'mpc-keys') {
  console.log(JSON.stringify(await mpc_keys(await Release.load()), null, 2));
} else if (command === 'deploy-evm') {
  const release = await Release.load();
  await release.lock(() => deploy_evm(release));
} else if (command === 'deploy-sui') {
  const release = await Release.load('deployment-sui.json');
  await release.lock(() => deploy_sui(release));
} else if (command === 'deploy-starknet') {
  const release = await Release.load('deployment-starknet.json');
  await release.lock(() => deploy_starknet(release));
} else if (command === 'deploy-solana') {
  const release = await Release.load('deployment-solana.json');
  await release.lock(() => deploy_solana(release));
} else if (command === 'configure-near') {
  const release = await Release.load();
  await release.lock(() => configure_near(release));
} else if (command === 'deployment-record') {
  await deployment_record();
} else if (command === 'live-read-probes') {
  const release = await Release.load('deployment-live.json');
  await release.lock(() => probe_reads(release));
} else if (command === 'live-prices') {
  const release = await Release.load('deployment-oracle.json');
  await release.lock(() => publish_live_prices(release));
} else if (command === 'live-oracle') {
  await watch_live_prices();
} else if (command === 'live-security') {
  const release = await Release.load('deployment-security.json');
  await release.lock(() => verify_unauthorized(release));
} else if (command === 'live-security-native') {
  const release = await Release.load('deployment-security.json');
  await release.lock(() => verify_native_authority(release));
} else if (command === 'live-report') {
  await live_report();
} else if (command === 'live-basket') {
  const release = await Release.load('deployment-basket.json');
  await release.lock(() => verify_basket(release));
} else if (command === 'local-services') {
  const release = await Release.load('deployment-services.json');
  await release.lock(() => local_services(release));
} else if (command === 'live-wallet-auth') {
  const release = await Release.load('deployment-wallets.json');
  await release.lock(() => verify_wallet_auth(release));
} else if (command === 'live-api') {
  const release = await Release.load('deployment-api.json');
  await release.lock(() => verify_api_lifecycle(release));
} else if (
  command === 'prepare-capabilities' ||
  command === 'activate-lending'
) {
  const release = await Release.load('deployment-enable.json');
  await release.lock(() =>
    command === 'prepare-capabilities'
      ? prepare_capabilities(release)
      : activate_lending(release),
  );
} else if (command === 'live-setup') {
  const release = await Release.load('deployment-verification.json');
  await release.lock(() => setup_live(release));
} else if (
  [
    'live-accept',
    'live-deposit',
    'live-locks',
    'live-fund',
    'live-gas',
    'live-settle',
    'live-release',
    'live-audit',
  ].includes(command ?? '')
) {
  const release = await Release.load('deployment-verification.json');
  const run = {
    'live-accept': accept_live,
    'live-deposit': deposit_live,
    'live-locks': verify_locks,
    'live-fund': fund_live,
    'live-gas': fund_controllers,
    'live-settle': settle_live,
    'live-release': release_live,
    'live-audit': audit_live,
  }[command!]!;
  await release.lock(() => run(release));
} else
  throw new Error(
    'Unknown testnet command. See the workspace README for deployment and verification commands.',
  );
