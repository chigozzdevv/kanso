import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { createHash } from 'node:crypto';
const root = new URL('../../', import.meta.url);
const read = async (path: string) => readFile(new URL(path, root), 'utf8');
const evm = JSON.parse(
  await read('contracts/evm/out/CollateralVault.sol/CollateralVault.json'),
) as { abi: unknown };
const starknet_vault = JSON.parse(
  await read(
    'contracts/starknet/target/dev/kanso_CollateralVault.contract_class.json',
  ),
) as { abi: unknown };
const starknet_account = JSON.parse(
  await read(
    'contracts/starknet/target/dev/kanso_ControllerAccount.contract_class.json',
  ),
) as { abi: unknown };
const near: Record<
  string,
  { payable: boolean; private: boolean; signature: string }
> = {};
for (const entry of (
  await readdir(new URL('contracts/near/src/', root), {
    recursive: true,
  })
).sort()) {
  if (!entry.endsWith('.rs')) continue;
  const text = await read('contracts/near/src/' + entry);
  if (!text.includes('impl Coordinator {')) continue;
  for (const match of text.matchAll(
    /((?:\s*#\[[^\]]+\])*)\s*pub fn (\w+)\s*\(([\s\S]*?)\)\s*(?:->\s*([^{]+))?\{/g,
  )) {
    const [, attributes = '', name = '', args = '', result = '()'] = match;
    near[name] = {
      payable: attributes.includes('#[payable]'),
      private: attributes.includes('#[private]'),
      signature: `(${args.trim()}) -> ${result.trim()}`,
    };
  }
}
const wasm = await readFile(
  new URL('contracts/near/target/near/kanso_coordinator.wasm', root),
);
const exports = new Set(
  WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map((x) => x.name),
);
for (const name of Object.keys(near)) if (!exports.has(name)) delete near[name];
const solana = await read('contracts/solana/src/state.rs');
const layouts: Record<string, { name: string; type: string }[]> = {};
for (const match of solana.matchAll(/pub struct (\w+)\s*\{([^}]+)\}/g)) {
  layouts[match[1]!] = [
    ...match[2]!.matchAll(/pub (\w+):\s*(\[[^\]]+\]|\w+),/g),
  ].map((x) => ({ name: x[1]!, type: x[2]! }));
}
const source_hashes: Record<string, string> = {};
for (const p of [
  'contracts/near/src/encoding.rs',
  'contracts/solana/src/state.rs',
  'contracts/solana/src/instruction.rs',
  'contracts/sui/sources/collateral_vault.move',
])
  source_hashes[p] = createHash('sha256')
    .update(await read(p))
    .digest('hex');
const values = {
  evm_vault_abi: evm.abi,
  starknet_vault_abi: starknet_vault.abi,
  starknet_controller_abi: starknet_account.abi,
  coordinator_methods: near,
  solana_layouts: layouts,
  source_hashes,
};
const rawOutput =
  '// Generated from contract artifacts and source by codegen.ts.\n' +
  Object.entries(values)
    .map(
      ([name, value]) =>
        `export const ${name} = ${JSON.stringify(value, null, 2)} as const;`,
    )
    .join('\n') +
  '\n';
const output = await format(rawOutput, {
  ...(await resolveConfig(
    fileURLToPath(new URL('src/generated.ts', import.meta.url)),
  )),
  parser: 'typescript',
});
const path = new URL('src/generated.ts', import.meta.url);
if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8')) !== output)
    throw new Error('Contract bindings are stale; run pnpm codegen');
} else {
  await mkdir(fileURLToPath(new URL('src/', import.meta.url)), {
    recursive: true,
  });
  await writeFile(path, output);
}
