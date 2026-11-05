import { generate_keys } from '@testnet/keys';
import { keys_directory } from '@testnet/store';
import { fund_testnet, testnet_status } from '@testnet/faucets';
import { prepare_starknet } from '@testnet/starknet';
import { Release } from '@testnet/deployment';
import { deploy_near } from '@testnet/deploy-near';
import { upgrade_near } from '@testnet/upgrade-near';
import { configure_bitcoin } from '@testnet/configure-bitcoin';
import { mpc_keys } from '@testnet/mpc';
import { deploy_evm } from '@testnet/deploy-evm';
import { deploy_sui } from '@testnet/deploy-sui';
import { deploy_starknet } from '@testnet/deploy-starknet';
import { deploy_solana } from '@testnet/deploy-solana';
import { configure_near } from '@testnet/configure-near';
import { deployment_config } from '@testnet/deployment-config';
import { publish_prices, watch_prices } from '@testnet/oracle';
import { fund_controllers } from '@testnet/controller-gas';
import { local_services } from '@testnet/local-services';
import { prepare_capabilities, activate_lending } from '@testnet/capabilities';

const command = process.argv[2];
const operations: Record<
  string,
  { journal?: string; run: (release: Release) => Promise<unknown> }
> = {
  'deploy-near': { run: deploy_near },
  'upgrade-near': { run: upgrade_near },
  'configure-bitcoin': { run: configure_bitcoin },
  'deploy-evm': { run: deploy_evm },
  'deploy-sui': { journal: 'deployment-sui.json', run: deploy_sui },
  'deploy-starknet': {
    journal: 'deployment-starknet.json',
    run: deploy_starknet,
  },
  'deploy-solana': { journal: 'deployment-solana.json', run: deploy_solana },
  'configure-near': { run: configure_near },
  prices: { journal: 'deployment-oracle.json', run: publish_prices },
  'fund-controllers': {
    journal: 'deployment-controllers.json',
    run: (release) =>
      fund_controllers(release, process.argv[3] ?? '', process.argv[4]),
  },
  'local-services': {
    journal: 'deployment-services.json',
    run: local_services,
  },
  'prepare-capabilities': {
    journal: 'deployment-enable.json',
    run: prepare_capabilities,
  },
  'activate-lending': {
    journal: 'deployment-enable.json',
    run: activate_lending,
  },
};

if (command === 'keys') {
  const index = await generate_keys();
  console.log(
    JSON.stringify(
      {
        directory: await keys_directory(),
        created_at: index.created_at,
        wallets: index.wallets,
      },
      null,
      2,
    ),
  );
} else if (command === 'status') {
  console.log(JSON.stringify(await testnet_status(), null, 2));
} else if (command === 'faucet') {
  await fund_testnet(
    process.argv[3],
    process.argv.includes('--retry-unavailable'),
  );
} else if (command === 'starknet-accounts') {
  console.log(JSON.stringify(await prepare_starknet(), null, 2));
} else if (command === 'mpc-keys') {
  console.log(JSON.stringify(await mpc_keys(await Release.load()), null, 2));
} else if (command === 'deployment-config') {
  await deployment_config();
} else if (command === 'oracle') {
  await watch_prices();
} else if (command && Object.hasOwn(operations, command)) {
  const operation = operations[command]!;
  const release = await Release.load(operation.journal);
  await release.lock(async () => {
    const result = await operation.run(release);
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  });
} else {
  throw new Error(
    'Unknown testnet command. See the workspace README for operations.',
  );
}
