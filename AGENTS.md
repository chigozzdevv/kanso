# AGENTS.md

Instructions for coding agents working in this repository. See [README.md](README.md) for the product overview.

## Project

Kanso gives a borrower one USDC loan against a basket of native assets held on several chains. A NEAR coordinator contract owns all debt, risk and custody permissions. Remote vaults hold collateral on their own chains and move it only through transactions the coordinator builds and signs with NEAR Chain Signatures.

There is no bridge or messaging protocol. NEAR MPC is the cross-chain layer: `verify_foreign_transaction` confirms source-chain transactions (see `contracts/near/src/mpc.rs`), and Chain Signatures signs outgoing ones. Bitcoin transactions are verified against the Bitcoin light client instead (`contracts/near/src/bitcoin_light_client.rs`).

The project is deployed on testnet. `deployments/testnet.json` describes the live deployment and is read by the server and the client.

## Layout

| Path                     | Contents                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `contracts/near`         | Coordinator contract (Rust, cargo-near). Tests in `contracts/near/tests`.                     |
| `contracts/evm`          | `CollateralVault.sol` shared by the six EVM networks (Foundry).                               |
| `contracts/solana`       | SOL vault program (Rust, LiteSVM tests).                                                      |
| `contracts/sui`          | SUI vault (Move).                                                                             |
| `contracts/starknet`     | Token vault and restricted controller account (Cairo, Scarb).                                 |
| `packages/schema`        | Zod schemas, integer amount math, offer encoding shared with Rust.                            |
| `packages/bindings`      | Contract interfaces generated from contract sources and build artifacts.                      |
| `packages/sdk`           | Framework-independent TypeScript SDK used by the client.                                      |
| `server/src`             | Fastify API and BullMQ workers. Business modules in `features/`, infrastructure in `shared/`. |
| `server/scripts/testnet` | Testnet deployment and maintenance CLI.                                                       |
| `client/src`             | Next.js App Router app, static export. UI in `features/` and `components/`.                   |
| `test`                   | `unit`, `sandbox` (compiled WASM on local nearcore), `integration`, `fixtures`.               |

## Commands

```sh
pnpm install --frozen-lockfile
pnpm build                # build all workspace packages
pnpm typecheck
pnpm lint                 # ESLint, zero warnings allowed
pnpm format:check         # Prettier
pnpm test                 # unit tests
pnpm codegen              # regenerate bindings after contract changes
pnpm codegen:check        # fail if bindings are stale
pnpm verify:backend       # full TypeScript gate, including sandbox and integration tests
pnpm verify:contracts     # full contract gate
```

Per-contract commands: `build:near`, `test:near`, `check:near`, and the same for `evm`, `solana`, `sui` and `starknet`. `test:sandbox` and `test:integration` need `build:near` first.

Dev processes (`dev:api`, `dev:worker`, `dev:client`, `testnet local-services`, `testnet oracle`) are long-running. Ask the user to start them instead of running them yourself.

## Conventions

- TypeScript imports use package names and aliases (`@schema/*`, `@bindings/*`, `@sdk/*`, `@server/*`, `@test/*`; `@/*` inside `client/src`). ESLint rejects relative imports.
- Use `import type` for type-only imports.
- Prettier: single quotes, trailing commas. Run `pnpm format` after editing.
- Token amounts are integer atomic units. Use `bigint` in code and decimal strings in JSON. Never use floating point for amounts, rates, health or limits. Rates and risk factors are basis points.
- Wallet, transaction and financial logic belongs in the SDK or the server, not in React components.
- Offer and wire encodings are shared between Rust and TypeScript. If you change one side, update the other and the golden vectors in `test/fixtures`.
- After changing a contract interface, rebuild the contract and run `pnpm codegen`.
- Commit messages use a type prefix: `feat:`, `fix:`, `refactor:`, `test:`, `doc:`, `chore:`.

## Rules that protect funds

These hold across the contracts, server and SDK. Do not weaken them.

- A loan funds only after every collateral leg is verified on-chain.
- One deposit, event or Bitcoin outpoint secures at most one obligation.
- The coordinator builds or fully validates every transaction it asks Chain Signatures to sign. Never add a path that signs a caller-supplied hash.
- Debt decreases only when USDC is received and applied by the coordinator.
- Each payout, repayment, sale and release applies exactly once. Retries reuse the original operation identity.
- A timeout or a submitted transaction is not proof of success or failure. Unresolved operations stay unresolved until canonical state proves the outcome.
- MongoDB and Redis hold projections and jobs. They never override contract state.

## Secrets and deployment state

- `.keys/` holds local testnet private keys and `.env` holds local configuration. Never print, commit or copy their contents.
- Deployment journals live outside the repo, in `~/Library/Application Support/Kanso/testnet` on macOS or `KANSO_STATE_DIR`. Do not delete them or `.keys/`; they are needed for recovery.
- Do not invent addresses, transaction hashes or evidence. Values in `deployments/testnet.json` come from real deployments.
- Testnet CLI commands (`pnpm --filter @kanso/server testnet <command>`) send real transactions. Ask before running any command that deploys, upgrades, funds accounts or changes capabilities.
- Do not retry a faucet request or transfer whose outcome is unresolved. Do not remove a leftover lock file without confirming its process has exited.

## Before you finish

Run the checks that cover what you changed. For TypeScript changes, run at least `pnpm typecheck`, `pnpm lint`, `pnpm format:check` and `pnpm test`. For contract changes, run that contract's `check:*` and `test:*` commands.
