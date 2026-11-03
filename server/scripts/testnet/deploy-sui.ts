import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import bs58 from 'bs58';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import type { SuiClientTypes } from '@mysten/sui/client';
import { sui } from '@testnet/network';
import { read_json } from '@testnet/store';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import type { MpcKeys } from '@testnet/mpc';

type Included = { effects: true; objectTypes: true; transaction: true };
export async function execute_sui(
  release: Release,
  id: string,
  tx: Transaction,
  key: Ed25519Keypair,
  intent: string,
) {
  let effect = release.journal.effects[id];
  if (effect && effect.intent !== intent)
    throw new Error(`Deployment intent changed: ${id}`);
  if (effect?.state === 'failed')
    throw new Error(`Recorded Sui transaction failed: ${id}`);
  if (!effect) {
    tx.setSender(key.toSuiAddress());
    const bytes = await tx.build({ client: sui });
    const data = Transaction.from(bytes).getData();
    if (BigInt(data.gasData.budget!) > 300_000_000n)
      throw new Error('Sui deployment exceeds 0.3 SUI budget');
    const signed = await key.signTransaction(bytes);
    effect = {
      intent,
      transaction_id: await tx.getDigest({ client: sui }),
      state: 'prepared',
      raw_transaction: JSON.stringify({
        bytes: toBase64(bytes),
        signatures: [signed.signature],
      }),
    };
    release.journal.effects[id] = effect;
    await release.save();
  }
  if (effect.state !== 'confirmed') {
    const signed = JSON.parse(effect.raw_transaction!) as {
      bytes: string;
      signatures: string[];
    };
    try {
      await sui.executeTransaction({
        transaction: fromBase64(signed.bytes),
        signatures: signed.signatures,
      });
    } catch (error) {
      console.log(
        `${id}: reconciling ${effect.transaction_id}: ${error instanceof Error ? error.message.slice(0, 150) : 'RPC interrupted'}`,
      );
    }
  }
  const result = await sui.waitForTransaction({
    digest: effect.transaction_id,
    include: { effects: true, objectTypes: true, transaction: true },
    timeout: 120_000,
  });
  if (result.$kind === 'FailedTransaction') {
    effect.state = 'failed';
    effect.result = result;
    await release.save();
    throw new Error(
      `Sui transaction failed: ${JSON.stringify(result.FailedTransaction.status)}`,
    );
  }
  effect.state = 'confirmed';
  effect.result = result.Transaction;
  await release.save();
  console.log(`${id}: ${effect.transaction_id}`);
  return result.Transaction as SuiClientTypes.Transaction<Included>;
}
export async function deploy_sui(release: Release) {
  const keyfile = await read_json<{ private_key: string }>(
    release.folder,
    'keys/sui-deployer.json',
  );
  const key = Ed25519Keypair.fromSecretKey(keyfile.private_key);
  const mpc = await read_json<MpcKeys>(release.folder, 'mpc.json');
  const compiled = await promisify(execFile)(
    'sui',
    [
      'move',
      'build',
      '--path',
      join(release.folder, '..', 'contracts/sui'),
      '--dump-bytecode-as-base64',
      '--no-tree-shaking',
    ],
    { maxBuffer: 2_000_000 },
  );
  const build = JSON.parse(compiled.stdout) as {
    modules: string[];
    dependencies: string[];
    digest: number[];
  };
  const network = await sui.core.getChainIdentifier();
  const genesis = Buffer.from(bs58.decode(network.chainIdentifier)).toString(
    'hex',
  );
  if (!genesis.startsWith('4c78adac'))
    throw new Error(`Expected Sui Testnet: ${network.chainIdentifier}`);
  const tx = new Transaction();
  const cap = tx.publish({
    modules: build.modules,
    dependencies: build.dependencies,
  });
  // The published package has no upgrade authority from its first transaction.
  tx.moveCall({ target: '0x2::package::make_immutable', arguments: [cap] });
  const published = await execute_sui(
    release,
    'sui-publish',
    tx,
    key,
    digest(JSON.stringify(build)),
  );
  const pkg = published.effects.changedObjects.find(
    (o) => o.outputState === 'PackageWrite',
  );
  if (!pkg) throw new Error('Sui package missing from publication effects');
  const controller = mpc.controllers.sui!;
  if (!controller.address) throw new Error('Missing Sui controller address');
  const deployment = `0x${digest(release.journal.deployment_id)}`;
  const network_word = `0x${genesis}`;
  const create = new Transaction();
  create.moveCall({
    target: `${pkg.objectId}::collateral_vault::create`,
    arguments: [
      create.pure.address(deployment),
      create.pure.address(network_word),
      create.pure.address(controller.address),
    ],
  });
  const created = await execute_sui(
    release,
    'sui-create-vault',
    create,
    key,
    digest(
      JSON.stringify({
        package: pkg.objectId,
        deployment,
        network: network_word,
        controller,
      }),
    ),
  );
  const vault = created.effects.changedObjects.find(
    (o) =>
      created.objectTypes[o.objectId] ===
      `${pkg.objectId}::collateral_vault::Vault`,
  );
  if (!vault) throw new Error('Sui vault missing from creation effects');
  const object = await sui.getObject({
    objectId: vault.objectId,
    include: { json: true },
  });
  const fields = object.object.json;
  if (
    !fields ||
    fields.controller !== controller.address ||
    fields.deployment !== deployment ||
    fields.network !== network_word
  )
    throw new Error(
      `Sui vault configuration mismatch: ${JSON.stringify(fields)}`,
    );
  if (
    published.effects.changedObjects.some(
      (o) =>
        published.objectTypes[o.objectId]?.endsWith('::package::UpgradeCap') &&
        o.outputState === 'ObjectWrite',
    )
  )
    throw new Error('Sui upgrade capability remains live');
  release.journal.contracts.sui = {
    family: 'sui',
    package: pkg.objectId,
    vault: vault.objectId,
    initial_shared_version: vault.outputVersion,
    controller,
    network_fingerprint: network.chainIdentifier,
    network_word,
    deployment,
    artifact_sha256: digest(JSON.stringify(build)),
    publish_transaction: published.digest,
    create_transaction: created.digest,
    immutable: true,
    enabled: false,
    verified_at: new Date().toISOString(),
  };
  await release.save();
  console.log(
    `Sui: verified immutable package ${pkg.objectId}, vault ${vault.objectId}`,
  );
}
