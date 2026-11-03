import {
  createPublicClient,
  encodeDeployData,
  getContractAddress,
  http,
  keccak256,
  parseTransaction,
  zeroAddress,
} from 'viem';
import type { Abi, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { evm_networks } from '@testnet/network';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import type { MpcKeys } from '@testnet/mpc';

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: {
    object: Hex;
    immutableReferences: Record<string, { start: number; length: number }[]>;
  };
}
const chain_names: Record<number, string> = {
  84532: 'base',
  421614: 'arbitrum',
  97: 'bnb',
  80002: 'polygon',
  43113: 'avalanche',
  998: 'hyperevm',
};

export async function deploy_evm(release: Release) {
  const key = await read_json<{ private_key: Hex }>(
    release.folder,
    'keys/evm-deployer.json',
  );
  const account = privateKeyToAccount(key.private_key);
  const mpc = await read_json<MpcKeys>(release.folder, 'mpc.json');
  const artifact = await release.artifact(
    'contracts/evm/out/CollateralVault.sol/CollateralVault.json',
  );
  const compiled = JSON.parse(artifact.bytes.toString()) as Artifact;
  const deployment = `0x${digest(release.journal.deployment_id)}` as Hex;
  for (const chain of evm_networks) {
    const name = chain_names[chain.id]!;
    const controller = mpc.controllers[name]!;
    if (!controller.address)
      throw new Error(`Missing EVM controller address: ${name}`);
    const client = createPublicClient({
      chain,
      transport: http(undefined, { timeout: 25_000, retryCount: 1 }),
    });
    if ((await client.getChainId()) !== chain.id)
      throw new Error('EVM chain mismatch');
    const data = encodeDeployData({
      abi: compiled.abi,
      bytecode: compiled.bytecode.object,
      args: [deployment, BigInt(chain.id), controller.address, zeroAddress],
    });
    const id = `evm-${name}-deploy`,
      intent = digest(
        JSON.stringify({ chain: chain.id, data, from: account.address }),
      );
    let effect = release.journal.effects[id];
    if (effect && effect.intent !== intent)
      throw new Error(`Deployment intent changed: ${id}`);
    if (effect?.state === 'failed')
      throw new Error(`Recorded deployment failed: ${name}`);
    if (!effect) {
      const nonce = await client.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      });
      const estimate = await client.estimateGas({ account, data });
      const gas = (estimate * 120n) / 100n,
        marketPrice = await client.getGasPrice();
      const balance = await client.getBalance({ address: account.address });
      const affordable = (balance * 8n) / 10n / gas;
      const gasPrice =
        marketPrice * 2n < affordable ? marketPrice * 2n : affordable;
      if (gasPrice < (marketPrice * 125n) / 100n)
        throw new Error(`${name}: insufficient deployment fee headroom`);
      if (gas * gasPrice > (balance * 9n) / 10n)
        throw new Error(
          `${name}: insufficient deployment funding; maximum fee ${gas * gasPrice}, balance ${balance}`,
        );
      const raw_transaction = await account.signTransaction({
        chainId: chain.id,
        nonce,
        gas,
        gasPrice,
        data,
        type: 'legacy',
      });
      effect = {
        intent,
        state: 'prepared',
        transaction_id: keccak256(raw_transaction),
        raw_transaction,
      };
      release.journal.effects[id] = effect;
      await release.save();
      console.log(
        `${name}: deployment estimated at ${estimate} gas; maximum fee ${gas * gasPrice} ${chain.nativeCurrency.symbol} atomic`,
      );
    }
    if (effect.state !== 'confirmed') {
      try {
        await client.sendRawTransaction({
          serializedTransaction: effect.raw_transaction as Hex,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          /max fee per gas less than block base fee/.test(error.message)
        ) {
          const original = parseTransaction(effect.raw_transaction as Hex);
          const nonce = original.nonce!;
          if (
            (await client.getTransactionCount({
              address: account.address,
              blockTag: 'pending',
            })) !== nonce
          )
            throw new Error(`${name}: reconcile nonce before replacing fee`, {
              cause: error,
            });
          const gasPrice = (await client.getGasPrice()) * 2n;
          if (
            original.gas! * gasPrice >
            ((await client.getBalance({ address: account.address })) * 9n) / 10n
          )
            throw new Error(
              `${name}: replacement fee exceeds deployment budget`,
              { cause: error },
            );
          const raw_transaction = await account.signTransaction({
            chainId: chain.id,
            nonce,
            gas: original.gas!,
            gasPrice,
            data,
            type: 'legacy',
          });
          (effect.replacements ??= []).push({
            transaction_id: effect.transaction_id,
            raw_transaction: effect.raw_transaction!,
          });
          effect.transaction_id = keccak256(raw_transaction);
          effect.raw_transaction = raw_transaction;
          await release.save();
          await client.sendRawTransaction({
            serializedTransaction: raw_transaction,
          });
        } else
          console.log(
            `${name}: reconciling ${effect.transaction_id} (${error instanceof Error ? error.message.slice(0, 100) : 'RPC interrupted'})`,
          );
      }
    }
    const receipt = await client.waitForTransactionReceipt({
      hash: effect.transaction_id as Hex,
      confirmations: 2,
      timeout: 120_000,
    });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      effect.state = 'failed';
      effect.result = receipt;
      await release.save();
      throw new Error(`Deployment reverted: ${name}`);
    }
    const tx = await client.getTransaction({ hash: receipt.transactionHash });
    const expected_address = getContractAddress({
      from: account.address,
      nonce: BigInt(tx.nonce),
    });
    if (
      expected_address.toLowerCase() !== receipt.contractAddress.toLowerCase()
    )
      throw new Error('Contract address mismatch');
    const address = receipt.contractAddress;
    const code = await client.getCode({ address });
    if (!code) throw new Error('Deployed code missing');
    const actual = Buffer.from(code.slice(2), 'hex'),
      expected = Buffer.from(compiled.deployedBytecode.object.slice(2), 'hex');
    for (const refs of Object.values(
      compiled.deployedBytecode.immutableReferences,
    ))
      for (const ref of refs) {
        actual.fill(0, ref.start, ref.start + ref.length);
        expected.fill(0, ref.start, ref.start + ref.length);
      }
    if (!actual.equals(expected))
      throw new Error(`Runtime code does not match artifact: ${name}`);
    const read = (functionName: string) =>
      client.readContract({ address, abi: compiled.abi, functionName });
    const values = await Promise.all([
      read('deployment'),
      read('networkId'),
      read('controller'),
      read('asset'),
    ]);
    if (
      values[0] !== deployment ||
      values[1] !== BigInt(chain.id) ||
      String(values[2]).toLowerCase() !== controller.address.toLowerCase() ||
      values[3] !== zeroAddress
    )
      throw new Error(`Immutable configuration mismatch: ${name}`);
    effect.state = 'confirmed';
    effect.result = {
      address,
      block_number: receipt.blockNumber.toString(),
      gas_used: receipt.gasUsed.toString(),
      effective_gas_price: receipt.effectiveGasPrice.toString(),
    };
    release.journal.contracts[name] = {
      family: 'evm',
      chain_id: chain.id,
      address,
      controller,
      deployment,
      asset: zeroAddress,
      artifact_sha256: artifact.sha256,
      runtime_keccak256: keccak256(code),
      transaction: receipt.transactionHash,
      block_number: receipt.blockNumber.toString(),
      immutable: true,
      enabled: false,
      verified_at: new Date().toISOString(),
    };
    await release.save();
    console.log(`${name}: verified ${address} (${receipt.transactionHash})`);
  }
}
