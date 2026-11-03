import { hash, CallData } from 'starknet';
import { rpc, STARKNET_RPC } from '@testnet/network';
import { directory, read_json, replace_json } from '@testnet/store';
import type { KeyIndex } from '@testnet/store';

const OZ_CLASS =
  '0x540d7f5ec7ecf317e68d48564934cb99259781b1ee3cedbbc37ec5337f8e688';

export async function prepare_starknet() {
  const chain = await rpc<string>(STARKNET_RPC, 'starknet_chainId', []);
  if (chain !== '0x534e5f5345504f4c4941')
    throw new Error('Expected Starknet Sepolia');
  const declared = await rpc<{ abi: string }>(
    STARKNET_RPC,
    'starknet_getClass',
    { block_id: 'latest', class_hash: OZ_CLASS },
  );
  const abi = JSON.parse(declared.abi) as {
    type: string;
    inputs?: { name: string; type: string }[];
  }[];
  const constructor = abi.find((item) => item.type === 'constructor');
  if (
    constructor?.inputs?.length !== 1 ||
    constructor.inputs[0]?.type !== 'core::felt252'
  )
    throw new Error('Unexpected OpenZeppelin account constructor');
  const folder = await directory(),
    index = await read_json<KeyIndex>(folder, 'index.json');
  for (const role of ['deployer', 'borrower']) {
    const key_file = `keys/starknet-${role}.json`,
      key = await read_json<{
        network: string;
        private_key: string;
        public_key: string;
        address?: string;
      }>(folder, key_file);
    const constructor_calldata = CallData.compile({
      publicKey: key.public_key,
    });
    const address = hash.calculateContractAddressFromHash(
      key.public_key,
      OZ_CLASS,
      constructor_calldata,
      0,
    );
    if (key.address && BigInt(key.address) !== BigInt(address))
      throw new Error('Starknet account metadata mismatch');
    await replace_json(folder, key_file, {
      ...key,
      address,
      class_hash: OZ_CLASS,
      address_salt: key.public_key,
      constructor_calldata,
    });
    if (
      !index.wallets.some(
        (wallet) => wallet.family === 'starknet' && wallet.role === role,
      )
    )
      index.wallets.push({ family: 'starknet', role, address, key_file });
  }
  await replace_json(folder, 'index.json', index);
  return index.wallets.filter((wallet) => wallet.family === 'starknet');
}
