import {
  Account,
  RpcProvider,
  constants,
  hash,
  extractContractHashes,
  CallData,
} from 'starknet';
import type {
  CompiledSierra,
  CompiledSierraCasm,
  InvocationsSignerDetails,
  DeployAccountContractPayload,
  DeclareContractTransaction,
  DeployAccountContractTransaction,
  Invocation,
  Call,
} from 'starknet';
import { rpc, STARKNET_RPC, balance } from '@testnet/network';
import { read_json } from '@testnet/store';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import type { MpcKeys } from '@testnet/mpc';
import { setTimeout as pause } from 'node:timers/promises';

const encode = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) =>
    typeof v === 'bigint' ? { $bigint: v.toString() } : v,
  );
const decode = (value: string) =>
  JSON.parse(value, (_, v: unknown) =>
    v && typeof v === 'object' && '$bigint' in v
      ? BigInt(String(v.$bigint))
      : v,
  ) as { payload: unknown; details: InvocationsSignerDetails };
const CHAIN = constants.StarknetChainId.SN_SEPOLIA;
type Kind = 'account' | 'declare' | 'invoke';

export async function starknet_send(
  release: Release,
  id: string,
  kind: Kind,
  intent: string,
  provider: RpcProvider,
  prepare: () => Promise<{
    payload: unknown;
    details: InvocationsSignerDetails;
    transaction_id: string;
  }>,
) {
  let effect = release.journal.effects[id];
  if (effect && effect.intent !== intent)
    throw new Error(`Deployment intent changed: ${id}`);
  if (effect?.state === 'failed')
    throw new Error(`Recorded Starknet transaction failed: ${id}`);
  if (!effect) {
    const prepared = await prepare();
    effect = {
      intent,
      state: 'prepared',
      transaction_id: prepared.transaction_id,
      raw_transaction: encode({
        payload: prepared.payload,
        details: prepared.details,
      }),
    };
    release.journal.effects[id] = effect;
    await release.save();
  }
  if (effect.state !== 'confirmed') {
    const { payload, details } = decode(effect.raw_transaction!);
    try {
      const result =
        kind === 'account'
          ? await provider.deployAccountContract(
              payload as DeployAccountContractTransaction,
              details,
            )
          : kind === 'declare'
            ? await provider.declareContract(
                payload as DeclareContractTransaction,
                details,
              )
            : await provider.invokeFunction(payload as Invocation, details);
      if (BigInt(result.transaction_hash) !== BigInt(effect.transaction_id))
        throw new Error('Starknet transaction hash mismatch');
    } catch (error) {
      console.log(
        `${id}: reconciling ${effect.transaction_id}: ${error instanceof Error ? error.message.slice(0, 350) : 'RPC interrupted'}`,
      );
    }
  }
  try {
    await provider.waitForTransaction(effect.transaction_id, {
      retryInterval: 3000,
      retries: 40,
    });
  } catch (error) {
    await pause(2000);
    // A gateway's status cache can lag an already included transaction.
    try {
      await rpc(STARKNET_RPC, 'starknet_getTransactionReceipt', {
        transaction_hash: effect.transaction_id,
      });
    } catch {
      throw error;
    }
  }
  await pause(1500);
  const receipt = await rpc<{ execution_status: string }>(
    STARKNET_RPC,
    'starknet_getTransactionReceipt',
    { transaction_hash: effect.transaction_id },
  );
  effect.state =
    receipt.execution_status === 'SUCCEEDED' ? 'confirmed' : 'failed';
  effect.result = receipt;
  await release.save();
  if (effect.state === 'failed')
    throw new Error(`Starknet transaction reverted: ${id}`);
  console.log(`${id}: ${effect.transaction_id}`);
  return receipt;
}

export async function deploy_starknet(release: Release) {
  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });
  if ((await provider.getChainId()) !== CHAIN)
    throw new Error('Expected Starknet Sepolia');
  const key = await read_json<{
    address: string;
    private_key: string;
    class_hash: string;
    address_salt: string;
    constructor_calldata: string[];
  }>(release.key_folder, 'starknet-deployer.json');
  const account = new Account({
    provider,
    address: key.address,
    signer: key.private_key,
    cairoVersion: '1',
  });
  const mpc = await read_json<MpcKeys>(release.folder, 'mpc.json');
  const tip = (await provider.getEstimateTip()).p95Tip;
  if (tip > 5_000_000_000n)
    throw new Error('Starknet network tip exceeds the deployment budget');
  const common = {
    version: '0x3' as const,
    chainId: CHAIN,
    walletAddress: key.address,
    cairoVersion: '1' as const,
    tip,
    paymasterData: [],
    accountDeploymentData: [],
    nonceDataAvailabilityMode: 'L1' as const,
    feeDataAvailabilityMode: 'L1' as const,
  };
  async function details(
    resourceBounds: InvocationsSignerDetails['resourceBounds'],
    nonce: bigint,
  ): Promise<InvocationsSignerDetails> {
    const maximum = Object.values(resourceBounds).reduce(
      (sum, r) => sum + BigInt(r.max_amount) * BigInt(r.max_price_per_unit),
      resourceBounds.l2_gas.max_amount * tip,
    );
    const funded = BigInt(
      (await balance({
        family: 'starknet',
        role: 'deployer',
        address: key.address,
        key_file: 'starknet-deployer.json',
      }))!,
    );
    if (maximum > funded / 2n)
      throw new Error(
        `Starknet fee exceeds deployment budget: ${maximum} of ${funded} STRK atomic`,
      );
    console.log(`Starknet: maximum transaction fee ${maximum} STRK atomic`);
    return { ...common, nonce, resourceBounds };
  }
  const deploy_account: DeployAccountContractPayload = {
    classHash: key.class_hash,
    addressSalt: key.address_salt,
    constructorCalldata: key.constructor_calldata,
    contractAddress: key.address,
  };
  await starknet_send(
    release,
    'starknet-deployer-account',
    'account',
    digest(JSON.stringify(deploy_account)),
    provider,
    async () => {
      const estimate = await account.estimateAccountDeployFee(deploy_account, {
        tip: 0,
      });
      const d = await details(estimate.resourceBounds, 0n);
      const payload = await account.buildAccountDeployPayload(
        deploy_account,
        d,
      );
      const transaction_id = hash.calculateDeployAccountTransactionHash({
        ...common,
        ...d,
        nonceDataAvailabilityMode: 0,
        feeDataAvailabilityMode: 0,
        contractAddress: key.address,
        classHash: key.class_hash,
        compiledConstructorCalldata: key.constructor_calldata,
        salt: key.address_salt,
      });
      return { payload, details: d, transaction_id };
    },
  );
  const classes: Record<string, string> = {};
  const artifacts: Record<string, string> = {};
  for (const name of ['CollateralVault', 'ControllerAccount']) {
    const sierra = await release.artifact(
      `contracts/starknet/target/dev/kanso_${name}.contract_class.json`,
    );
    const casm = await release.artifact(
      `contracts/starknet/target/dev/kanso_${name}.compiled_contract_class.json`,
    );
    const payload = {
      contract: JSON.parse(sierra.bytes.toString()) as CompiledSierra,
      casm: JSON.parse(casm.bytes.toString()) as CompiledSierraCasm,
    };
    const block = await provider.getBlock('latest');
    const extracted = extractContractHashes(payload, block.starknet_version);
    classes[name] = extracted.classHash;
    artifacts[name] = sierra.sha256;
    await starknet_send(
      release,
      `starknet-declare-${name}`,
      'declare',
      digest(sierra.sha256 + casm.sha256),
      provider,
      async () => {
        const estimate = await account.estimateDeclareFee(payload, { tip: 0 });
        const d = await details(
          estimate.resourceBounds,
          BigInt(await account.getNonce()),
        );
        const built = await account.buildDeclarePayload(payload, d);
        return {
          payload: built,
          details: d,
          transaction_id: hash.calculateDeclareTransactionHash({
            ...common,
            ...d,
            nonceDataAvailabilityMode: 0,
            feeDataAvailabilityMode: 0,
            classHash: extracted.classHash,
            compiledClassHash: extracted.compiledClassHash!,
            senderAddress: key.address,
          }),
        };
      },
    );
  }
  const custody = mpc.controllers.starknet!;
  const x = BigInt(`0x${custody.public_key.slice(0, 64)}`),
    y = BigInt(`0x${custody.public_key.slice(64)}`),
    mask = (1n << 128n) - 1n;
  const deployment =
    BigInt(`0x${digest(release.journal.deployment_id)}`) & ((1n << 250n) - 1n);
  const token =
    '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const salt = deployment.toString();
  const calldata = [
    x & mask,
    x >> 128n,
    y & mask,
    y >> 128n,
    classes.CollateralVault!,
    deployment,
    salt,
    token,
    CHAIN,
  ].map(String);
  const deploy = {
    classHash: classes.ControllerAccount!,
    constructorCalldata: calldata,
    salt,
    unique: false,
  };
  const { calls, addresses } = account.deployer.buildDeployerCall(
    deploy,
    key.address,
  );
  const controller = addresses[0]!;
  await starknet_send(
    release,
    'starknet-create-controller-vault',
    'invoke',
    digest(JSON.stringify(deploy)),
    provider,
    async () => {
      const estimate = await account.estimateInvokeFee(calls, { tip: 0 });
      const d = await details(
        estimate.resourceBounds,
        BigInt(await account.getNonce()),
      );
      const payload = await account.buildInvocation(calls, d);
      return {
        payload,
        details: d,
        transaction_id: hash.calculateInvokeTransactionHash({
          ...common,
          ...d,
          nonceDataAvailabilityMode: 0,
          feeDataAvailabilityMode: 0,
          senderAddress: key.address,
          compiledCalldata: CallData.compile(payload.calldata ?? []),
        }),
      };
    },
  );
  const vault_result = await provider.callContract({
    contractAddress: controller,
    entrypoint: 'get_vault',
    calldata: [],
  });
  const vault = vault_result[0]!;
  const config = await provider.callContract({
    contractAddress: vault,
    entrypoint: 'get_config',
    calldata: [],
  });
  if (
    config.length !== 4 ||
    BigInt(config[0]!) !== deployment ||
    BigInt(config[1]!) !== BigInt(CHAIN) ||
    BigInt(config[2]!) !== BigInt(controller) ||
    BigInt(config[3]!) !== BigInt(token)
  )
    throw new Error('Starknet vault configuration mismatch');
  if (
    BigInt(await provider.getClassHashAt(vault)) !==
      BigInt(classes.CollateralVault!) ||
    BigInt(await provider.getClassHashAt(controller)) !==
      BigInt(classes.ControllerAccount!)
  )
    throw new Error('Starknet deployed class mismatch');
  release.journal.contracts.starknet = {
    family: 'starknet',
    controller,
    vault,
    custody_public_key: custody.public_key,
    derivation_path: custody.path,
    sign_domain: custody.domain,
    deployment: deployment.toString(),
    token,
    classes,
    artifacts,
    immutable: true,
    enabled: false,
    verified_at: new Date().toISOString(),
  };
  await release.save();
  console.log(`Starknet: verified controller ${controller}, vault ${vault}`);
}

export async function starknet_invoke(
  release: Release,
  id: string,
  calls: Call[],
) {
  const provider = new RpcProvider({ nodeUrl: STARKNET_RPC });
  if ((await provider.getChainId()) !== CHAIN)
    throw new Error('Expected Starknet Sepolia');
  const key = await read_json<{ address: string; private_key: string }>(
    release.key_folder,
    'starknet-deployer.json',
  );
  const account = new Account({
    provider,
    address: key.address,
    signer: key.private_key,
    cairoVersion: '1',
  });
  return starknet_send(
    release,
    id,
    'invoke',
    digest(JSON.stringify({ from: key.address, calls })),
    provider,
    async () => {
      const tip = (await provider.getEstimateTip()).p95Tip;
      if (tip > 5_000_000_000n)
        throw new Error('Starknet tip exceeds verification limit');
      const estimate = await account.estimateInvokeFee(calls, { tip });
      const maximum = Object.values(estimate.resourceBounds).reduce(
        (sum, r) => sum + r.max_amount * r.max_price_per_unit,
        estimate.resourceBounds.l2_gas.max_amount * tip,
      );
      if (maximum > 5n * 10n ** 18n)
        throw new Error('Starknet source transaction exceeds 5 STRK fee limit');
      const details: InvocationsSignerDetails = {
        walletAddress: key.address,
        cairoVersion: '1',
        chainId: CHAIN,
        version: '0x3',
        nonce: BigInt(await account.getNonce()),
        resourceBounds: estimate.resourceBounds,
        tip,
        paymasterData: [],
        accountDeploymentData: [],
        nonceDataAvailabilityMode: 'L1',
        feeDataAvailabilityMode: 'L1',
      };
      const payload = await account.buildInvocation(calls, details);
      return {
        payload,
        details,
        transaction_id: hash.calculateInvokeTransactionHash({
          ...details,
          nonceDataAvailabilityMode: 0,
          feeDataAvailabilityMode: 0,
          senderAddress: key.address,
          compiledCalldata: CallData.compile(payload.calldata ?? []),
        }),
      };
    },
  );
}
