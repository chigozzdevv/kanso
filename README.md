# Kanso

Kanso coordinates one LP-funded USDC loan against a basket held on its source chains. [kanso.md](kanso.md) defines the product and its deployment acceptance gates.

The contract implementation covers NEAR, Bitcoin Testnet3, Solana devnet, six EVM testnets, Sui testnet and Starknet Sepolia. [Runtime configuration](deployments/testnet.json) controls enabled capabilities. All eleven supported chains have passed live Testnet lifecycle verification.

## Contracts

| Location             | Responsibility                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `contracts/near`     | Canonical pools, offers, loans, risk, settlement, source verification and constrained signing.          |
| `contracts/evm`      | Immutable native/ERC20 collateral vault shared by Base, Arbitrum, BNB, Polygon, Avalanche and HyperEVM. |
| `contracts/solana`   | Native SOL custody, per-lock PDAs and immutable command receipts.                                       |
| `contracts/sui`      | Shared vault with native SUI balances, bounded execution and typed events.                              |
| `contracts/starknet` | Token vault and restricted secp256k1 controller account supporting Invoke V3.                           |
| `packages/schema`    | Runtime schemas, integer arithmetic and versioned offer commitments.                                    |
| `test/fixtures`      | Shared encoding and signed Solana execution vectors.                                                    |
| `test/sandbox`       | Compiled NEAR WASM lifecycle tests against a local nearcore node.                                       |

Bitcoin custody uses per-leg MPC-derived P2WPKH keys and BIP143 transactions constructed by the coordinator. Deposits, spend delivery and additional-output recovery use Bitcoin transaction inclusion proofs verified by [NEAR One's Bitcoin light client](https://github.com/Near-One/btc-light-client-contract). There is no Bitcoin application program to deploy.

The Testnet integration targets `btc-client-v4.testnet` v0.5.3 on **Bitcoin Testnet3**. Kanso recomputes the raw transaction ID and sends the transaction and coinbase Merkle paths through the light client's Borsh `verify_transaction_inclusion_v2` interface. Confirmations come from the loan's historical manifest. A private callback checks inclusion and header freshness before updating the current loan or spend. Coinbase outputs are excluded. Failed callbacks can be retried without crediting collateral or releasing reservations early.

Verifier bindings are immutable per manifest version and stored separately from existing root state. Register a binding for each new Bitcoin manifest; existing deposits retain their addresses and signing paths. SPV establishes canonical inclusion, while Kanso's exclusive custody keys and global outpoint ledger prevent reuse within the protocol. The external client's checkpoint, proof-of-work configuration and upgrade administrators remain trust assumptions. Its retained-header window also bounds how old an unprocessed proof may be. The configuration command checks the reviewed deployment's code hash before binding it. Chain Signatures continues signing constrained spends; Bitcoin admission no longer requests read-MPC attestations.

## Accounting and execution

Offers bind deployment, borrower, payout, policy version, exact principal, APR, maturity and the complete ordered basket. Funding requires every committed leg, fresh prices, unchanged terms and sufficient reserved pool liquidity. Incorrect source deposit amounts remain recorded and refundable without receiving credit.

Interest is simple Actual/365 on outstanding principal. Fractional remainders survive checkpoints; obligations round up. The payout equals principal, fees remain separate, and repayment applies to fees, interest, then principal. Policy changes preserve accepted terms. LP share pricing includes receivables and accrued interest; reservations, escrow, refunds, donations and recognized losses have separate accounting.

Health combines fresh, conservative per-asset values and weights. Per-asset caps aggregate across legs. Committed solver escrow appears separately as secured recovery value and never creates borrowing capacity. Parallel recovery reserves one shared repayment limit; source reservations and revision checks prevent reuse of collateral.

Top-ups, safe excess withdrawals, incoming-first replacements, wallet-funded repayments, optional cumulative conditional repayment, partial liquidation and post-default loss recognition share the same loan record. Wallet-payment inputs do not become pledged collateral. A third-party payer receives that payment's surplus; collateral-sale surplus belongs to the borrower.

Settlement currently uses funded internal solver escrow. A solver transfers the exact net USDC output before source collateral can be committed. Debt changes only after authenticated source delivery. Cancellation releases escrow only after an unsigned operation is cancelled or an executable spend is proven invalidated. Expiry alone cannot refund signed spending authority.

Outgoing signing accepts bounded transaction parameters and constructs the complete transaction on-chain. It never accepts arbitrary signing hashes or unrestricted calls. Account nonces, source nonces, gas objects, UTXOs, fee ceilings, recipients and replay identities are checked. Retries retain their original intent, and valid signatures can be resubmitted if a callback is lost.

Bitcoin tracks confirmed change before reuse, supports bounded fee replacements and competing cancellation spends, and separately returns additional unassigned outputs to the committed refund script. Each recovery spends one output. Outputs below economically spendable limits remain visible rather than being credited as recovered.

## Pool accounting and governance

Pool NAV is cash plus pending outgoing transfers plus active loan debt (outstanding principal, accrued interest and unpaid fees). Moving cash into a pending payout does not create a second asset. Loan reservations reduce available cash without reducing NAV. Recognizing an exhausted default removes its remaining receivable; the cumulative loss counter is an audit record and is not subtracted again. Source collateral, solver escrow and refundable payments are separate liabilities and assets.

After the first deposit, minted shares equal `floor(deposit × total shares / NAV before deposit)`. Withdrawal claims use the current share price and require cash after loan reservations and the pool's minimum liquidity buffer. Successful payout burns the reserved shares; failed payout restores cash and leaves the claim retryable. Loan interest and origination fees accrue to LPs; there is currently no separate manager or protocol fee allocation. NAV includes unrealized receivables, so share value does not promise immediately withdrawable cash or a guaranteed return.

The creator manages its pool. Only that manager can publish the next policy version within protocol limits or propose a successor. `propose_pool_manager`, `accept_pool_manager` and `cancel_pool_manager_transfer` implement a two-step handoff; acceptance checks the current pool revision. Accepted loans retain their agreed policy and terms. Pool-level liquidity settings can affect current withdrawal availability. LP shares do not carry voting rights, and no DAO voting system or policy-change delay is implemented. A manager or protocol owner can be a NEAR multisig/DAO account, but that account's governance is external to this coordinator.

## Coordinator upgrades

The protocol owner schedules the SHA-256 hash of reviewed WASM with `schedule_upgrade`; execution must wait at least 60 seconds on the current Testnet coordinator. Upload the exact bytes through `stage_upgrade_chunk` in chunks of at most 128,000 bytes, using increasing byte offsets and the scheduled hash. Repeating an identical chunk is safe; conflicting or out-of-order chunks fail. Prepay storage credit for the upload (roughly the WASM byte length times the network storage byte price). `get_upgrade_status` exposes the proposal, uploaded byte count and last completed hash.

After the delay, call `execute_upgrade` with `{"code":null}` and 300 Tgas. It hashes the entire staged WASM and batches deployment with private `migrate` on the same account. Failure rolls back the deployment and retains the proposal and staged bytes. Successful migration preserves version-1 root state, loans, pool shares and accounting, then clears the upload. A future incompatible state layout requires an explicit migration from its previous layout. `cancel_upgrade` discards the proposal and upload. Ownership uses `propose_owner`, `accept_owner` and `cancel_owner_transfer`; acceptance also cancels pending upgrades.

This upgrade authority can replace validation and signing logic and therefore has effective custody power. Any full-access key on the coordinator account can bypass the contract timelock. The current Testnet coordinator has no account access keys; check `view_access_key_list` on the NEAR RPC before an upgrade. Remote vaults remain immutable, versioned deployments; existing loans retain their original vault and manifest version.

## Local testnet credentials

`.testnet/` contains local testnet keys, a public address index and the faucet request journal. It is ignored by Git, lint and formatting. Directories use mode `0700`; credential files use `0600`. These are local plaintext keys protected by filesystem permissions. `pnpm testnet:keys` generates keys once and reuses the existing index without rotating them. Recovery-attestor keys share this development machine and do not provide independent production attestation. MPC custody keys must come from the actual signer derivation.

```sh
pnpm testnet:keys
pnpm --filter @kanso/server testnet starknet-accounts
pnpm testnet:faucet
pnpm testnet:status
```

The Starknet account command verifies the Sepolia chain and declared OpenZeppelin account constructor before storing deterministic account metadata. Funding the address does not deploy the account. Automated faucets support NEAR, Solana Devnet, Sui Testnet and Starknet Sepolia. Sui and Starknet use their documented public proof-of-work APIs. Requests are journaled before submission, and uncertain outcomes are retained rather than submitted again. An explicitly failed attempt can be retried with `pnpm testnet:faucet sui --retry-unavailable` (or another supported family). Do not retry an unresolved payment. A leftover `faucet.lock` after a process crash requires checking that process and its journal before removing the lock. Other networks may require a manual faucet claim. `testnet:status` verifies network balances; creating keys or requesting tokens does not deploy Kanso contracts.

## Interfaces and operations

The static client includes the landing page and `/app/` borrowing workspace, with basket selection, wallet connections, SDK offers, resumable operation progress, loan reads, direct USDC and solver-backed repayment, collateral release and pool discovery/deposits. Repayment supports wallet assets and pledged collateral, with USDC target estimates, a fresh review after wallet funding and returns of unused payment assets. Client components live under `client/src/features` and share the SDK rather than rebuilding transaction policy in React.

During development, `/app/preview/repayment/` shows the shared repayment form and review screens with sample assets, prices and fees. It sends no transactions and needs no wallet or API connection. The preview is unavailable in production builds.

Set `NEXT_PUBLIC_KANSO_API_URL` and `NEXT_PUBLIC_KANSO_AUTH_DOMAIN` in the root `.env` before building the client. The auth domain must match the API's `AUTH_DOMAIN`. `CLIENT_ORIGINS` is the API's comma-separated browser origin allowlist; restart the API after changing it. Only explicitly named public configuration is embedded in the static client. RPC credentials and signing keys remain server-side.

TypeScript imports use workspace package names and `@schema/*`, `@bindings/*`, `@sdk/*`, `@server/*` and `@test/*` aliases. The client uses `@/*` for `client/src`. Builds resolve internal aliases. ESLint rejects relative TypeScript imports, including TSX.

Amounts use decimal strings and integer arithmetic. Offer encoding version 2 uses the `kanso:offer` domain, explicit integer widths and length-prefixed strings/vectors; SHA-256 commits the encoded bytes. Rust and TypeScript share golden vectors.

Mutations authorizing NEAR spending require one yoctoNEAR. Native deposits attach the committed collateral quantity. Storage is prepaid separately with `storage_deposit`; record creation charges the payer's available credit. Historical records remain durable. Withdrawn unused storage credit follows the same tracked transfer lifecycle.

USDC arrives through the configured NEP-141 token's `ft_transfer_call`:

```json
{ "kind": "pool_deposit", "pool_id": "pool", "operation_id": "deposit" }
```

```json
{ "kind": "repayment", "loan_id": "loan", "operation_id": "payment" }
```

```json
{ "kind": "solver_escrow", "operation_id": "settlement" }
```

Payment identities are scoped to their payer. Replays cannot reduce debt or mint shares twice. The token resolver returns unused direct-repayment amounts. Settlement surplus creates a durable refund claimed through `claim_refund`; a failed payout preserves the liability for retry.

NEAR transfers persist the promise outcome before accounting finalization. Anyone can retry `finalize_transfer`; a repeated finalization has no financial effect. If the result callback itself is interrupted, recovery requires signatures from a preconfigured threshold of independent outcome attestors over the exact transfer and finalized receipt identity. This is an explicit attestor trust boundary, not a trustless NEAR receipt proof. Configure it before the first transfer; the policy then freezes. Testnet transfers require this configuration. Sandbox tests additionally exercise the ordinary callback path without attestors.

The coordinator's immutable manifest versions bind network fingerprints, source contracts, asset identity, signer domains/keys, finality and fee bounds. New commitments require an enabled version and verified derived controller key. Existing operations retain their original version. Pauses stop new risk while preserving repayment, proof reconciliation and owed refunds.

## Build and test

Toolchains used for verification:

| Tool                        | Version                     |
| --------------------------- | --------------------------- |
| Node / pnpm                 | Node 22.22.2+ / pnpm 12.3.4 |
| Rust / cargo-near           | 1.93.0 / 0.22.0             |
| Foundry / Solidity          | Forge 1.5.1 / solc 0.8.30   |
| Solana / SBF platform tools | 3.1.7 / 1.52                |
| Sui                         | 1.73.1-ff1fe0ec4551         |
| Scarb / Starknet Foundry    | 2.21.0 / 0.64.1             |
| Universal Sierra Compiler   | 2.10.3                      |
| NEAR sandbox                | nearcore 2.13.4             |

Rust and Cairo dependencies are locked. Sui's framework is pinned in `Move.toml`. Install the EVM test dependency with:

```sh
forge install foundry-rs/forge-std@v1.12.0 --no-git --root contracts/evm
pnpm install --frozen-lockfile
```

Put the native toolchains on `PATH`. Bitcoin's secp256k1 dependency also needs a compiler capable of targeting WASM. With WASI SDK 34 installed, set:

```sh
export CC_wasm32_unknown_unknown="$WASI_SDK_PATH/bin/clang"
export AR_wasm32_unknown_unknown="$WASI_SDK_PATH/bin/llvm-ar"
pnpm verify:contracts
```

Individual commands are available as `build:near`, `build:evm`, `build:solana`, `build:sui`, `build:starknet`, their `test:*` equivalents, `check:contracts` and `test:sandbox`. `test:solana` builds the SBF artifact before running LiteSVM. `test:sandbox` requires `build:near` and permission to bind local ports.

NEAR builds use `cargo-near` with its host-function configuration and WASM optimization; deployable artifacts are under `contracts/near/target/near`. Solana emits `target/deploy`, EVM emits `out`, Sui emits `build`, and Starknet emits `target/dev`. Generated artifacts, caches and local keys are ignored.

The test suites cover financial lifecycles, donation/replay resistance, failed and interrupted payouts, cumulative authorizations, collateral changes, concurrent recovery, wrong receipts/recipients, bounded signatures, source vault authorization and Bitcoin fee/change handling. EVM includes 1,024 randomized partial-spend cases. The Solana suite executes a transaction actually constructed and signed by the NEAR coordinator. Move tests assert event BCS bytes against the coordinator's decoder. Cairo tests validate real secp256k1 signatures and restricted account execution. Sandbox tests deploy compiled WASM and a standards-based test token, with actual transfers and token resolver behavior.

## Headless SDK and server

`packages/bindings` generates contract interfaces from the Rust sources, compiled NEAR exports, EVM ABI, Solana layouts and Cairo ABI. Run `pnpm codegen` after building contracts; `pnpm codegen:check` detects stale output. `packages/sdk` contains framework-independent request, wallet, operation, loan, collateral, repayment and pool handles. Business modules live under `server/src/features`; database, queues, indexing, NEAR clients and configuration live under `server/src/shared`.

The API authenticates NEAR ownership with NEP-413 and separately verifies linked source wallets. Wallet adapters implement `WalletPort`; they report the selected network, sign the documented ownership challenge and submit the family-specific transaction action. Bitcoin ownership uses BIP-322 simple P2WPKH. Starknet uses the exported `starknet_auth_message` SNIP-12 message, whose challenge is printable JSON preserving the original text; serialize its signature as a JSON array of felt strings. Set SDK `auth_domain` when the authentication domain differs from the API hostname.

Operations persist reviewed plans, revisions, wallet submission identities and progress in MongoDB. The SDK independently checks prepared actions before asking a wallet to sign. Beginning a wallet step commits its journal state before broadcasting. An interrupted response remains unresolved until canonical state or the original transaction establishes the result. A checkpoint contains deployment, owner, operation identity and plan hash; it contains no keys or session token. Reconnect the session before resuming it. A failed transfer with a verified failure outcome can be retried by preparing a new operation with a new idempotency key. A timeout does not authorize another spend.

MongoDB must run as a replica set or through mongos: operation revisions and queue outbox events commit in one database transaction. Redis and BullMQ deliver reconciliation jobs; duplicate delivery retains the same intent and signed transaction bytes. Separate API and worker processes share the same database, Redis and deployment configuration. The indexer preserves known closed loans and indexes canonical coordinator events from journaled transactions. It discovers configured pools and objects referenced by operations; it is not a complete historical chain explorer.

Workers reconcile source verification/signatures, publish durable jobs, monitor loan health and prepare funded conditional repayment or liquidation. They execute only contract-authorized keeper actions through the configured solver account. Voluntary borrower actions still require the borrower's wallet. Conditional spending uses remaining cumulative budgets; liquidation targets the pool's recovery health and shared repayment limit. A configured relayer can retry accounting finalization when a native transfer outcome is already known. Missing native outcome callbacks still require the contract's configured attestation quorum.

For local infrastructure:

```sh
docker compose up -d --wait
cp .env.example .env
```

The pnpm API, worker and testnet commands run from `server/` and load the root `.env`. Resolve `DEPLOYMENT_FILE` from that directory, or use an absolute path. `deployments/testnet.json` matches the runtime schema in `packages/schema/src/chain.ts` and references the actual Testnet coordinator and Circle USDC Testnet contract. Configured testing chains remain disabled until their manifest, live evidence and reconciliation service are verified. Configure the authentication domain and funded relayer/solver accounts as needed. `SOLVER_RECIPIENTS` maps source chain IDs to hex-encoded destination bytes (Bitcoin uses the output script). Keys belong in process secrets, never deployment JSON or SDK checkpoints. The local Compose services bind to loopback. `BASE_RPC_URL` and `BITCOIN_RPC_URL` override server reads, source transaction context and broadcasts without changing public SDK endpoints. `TATUM_API_KEY` is sent only to Tatum gateways in an HTTP header; authenticated requests reject redirects. Startup verifies the Base chain ID and Bitcoin genesis before using these overrides. These settings do not change the RPC providers used by the external MPC network.

```sh
pnpm build
pnpm dev:api
pnpm dev:worker
```

The integration suite starts its own MongoDB replica set, Redis process and NEAR sandbox, deploys compiled WASM, and uses real wallet signatures and token transfers. Install Redis or set `REDIS_SERVER_BIN`; MongoDB Memory Server downloads MongoDB 8.2.2 on its first run. `MONGOMS_DOWNLOAD_DIR` can select its binary cache. Build NEAR WASM before these tests.

```sh
pnpm verify:backend
```

This checks generated bindings, builds, types, lint, formatting, unit tests, compiled-WASM sandbox tests and SDK/API/worker integration tests. Public source-chain transactions and deployed MPC extraction/signing are separate validation gates. Remote origination remains disabled unless the pinned manifest, execution evidence and reconciliation service are available. Internal solver configuration alone does not enable a source chain.

## Enablement boundaries

No deployment addresses, public transaction evidence or production oracle feeds are fabricated. The configured account-operated oracle is authenticated but intended for development. Production feeds, risk calibration and the actual deployed MPC domains/extractors must be independently verified.

Before enabling a source deployment, retain the network-specific evidence required by specification section 22.3. Solana must have no upgrade authority; Sui's package upgrade capability must be destroyed; deployed EVM/Cairo code and NEAR account upgrade authority must match the reviewed deployment policy. These are deployment actions, not results established by local VM tests.

Mainnet NEAR Intents routing and its provider receipts/refunds remain separate integration scope. The client implements the landing page, browser wallet connections and borrowing workspace. Mainnet provider settlement is not enabled by the internal solver tests. Real-asset lending is not enabled.

## Landing page

`client` is a Next.js App Router workspace with static export for Firebase Hosting. `src/app/page.tsx` composes focused sections in `src/features/landing`; navigation and shared icons live in `src/components`. Each section owns its CSS module. The page includes rotating asset combinations with pause and reduced-motion support, responsive navigation, network filters and a native FAQ accordion. Network availability and verification links come from the public deployment manifest, resolved at build time. The landing page has no dependency on a running API or private environment variables.

```sh
pnpm dev:client
pnpm --filter @kanso/client build
```

The development server uses `http://127.0.0.1:3000`. The production export is `client/out`; `firebase.json` configures that directory for hosting. Page links lead to implemented sections and verified Testnet contracts. The `/app` workspace connects supported wallets, builds baskets, manages loans and supplies or withdraws pool liquidity through the SDK and API.

## Public Testnet deployment

The deployment uses [Circle's official USDC on NEAR Testnet](https://developers.circle.com/stablecoins/usdc-contract-addresses#testnet): `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`, with six decimals. The public pool is `usdc`. Current coordinator, vault, controller and light-client configuration is in `deployments/testnet.json`, which the server and client consume.

The coordinator has no account access keys and upgrades through the owner's current minimum 60-second Testnet timelock. EVM vault controllers are immutable, Solana's upgrade authority is removed, and Sui's UpgradeCap was destroyed during publication. USDC follows Circle's token controls. The owner and recovery attestors share one development machine.

Run deployment and maintenance commands from the workspace root:

```sh
pnpm --filter @kanso/server testnet deploy-near
pnpm --filter @kanso/server testnet configure-near
pnpm --filter @kanso/server testnet upgrade-near
pnpm --filter @kanso/server testnet configure-bitcoin
pnpm --filter @kanso/server testnet mpc-keys
pnpm --filter @kanso/server testnet deploy-evm
pnpm --filter @kanso/server testnet deploy-solana
pnpm --filter @kanso/server testnet deploy-sui
pnpm --filter @kanso/server testnet deploy-starknet
pnpm --filter @kanso/server testnet deployment-config
```

`upgrade-near` resumes staged uploads and executes the reviewed artifact after the contract timelock. `configure-bitcoin` registers the reviewed light client against existing Bitcoin manifests without enabling borrowing. `deployment-config` validates the coordinator's settlement token and account keys, then updates the runtime configuration while preserving configured pools and manifests.

Controller gas can be replenished from the local deployer wallets:

```sh
pnpm --filter @kanso/server testnet fund-controllers gas-topup-2026-11-03
pnpm --filter @kanso/server testnet fund-controllers gas-topup-2026-11-03 base
```

The optional chain ID restricts the operation to that network. Reuse the run ID to reconcile the same transfers; choose a new ID only for an intentional additional top-up. The command uses fixed Testnet gas amounts for EVM, Solana, Sui and Starknet controllers. It does not transfer settlement USDC.

Capability changes retain the existing private verification journals:

```sh
pnpm --filter @kanso/server testnet prepare-capabilities
pnpm --filter @kanso/server testnet activate-lending
```

`prepare-capabilities` requires paused origination and complete onchain lifecycle, authority, wallet, basket and accounting evidence. It registers the next immutable manifest versions and leaves incomplete chains disabled. Restart the API and worker with the resulting runtime configuration before `activate-lending`; activation verifies the recorded Circle USDC lifecycle, worker connectivity, API catalog, canonical manifests, fresh prices and pool liquidity. These gates require the original evidence in `.testnet/`; the commands do not generate it or bypass missing checks.

Start the local services and application processes in separate terminals:

```sh
pnpm --filter @kanso/server testnet local-services
pnpm dev:api
pnpm dev:worker
pnpm --filter @kanso/server testnet oracle
```

`local-services` starts a persistent MongoDB replica set and Redis under `.testnet/`, prints their connection URLs and stops them on SIGINT or SIGTERM. Set `MONGODB_URI` and `REDIS_URL` in the root `.env` to those URLs before starting the API and worker. Defaults are MongoDB port 27021 and Redis port 6381; override them with `TESTNET_MONGO_PORT` and `TESTNET_REDIS_PORT`. Commands load the root `.env`.

`oracle` publishes fresh CoinGecko observations using the development oracle account, with an explicit 1% conservative haircut. `prices` publishes once. Stale prices block new risk. The feed and internal solver are development infrastructure.

Operations preserve signed transactions and receipts in ignored `.testnet/deployment*.json` journals before broadcasting. Ambiguous responses are reconciled with the original transaction identity. Changed deployment intent and recorded chain failures stop the affected step. EVM fee replacements reuse the original nonce; Solana code uploads reuse the existing program and buffer. Keep these journals and keys for recovery. Before removing a leftover deployment lock after a crash, establish that its recorded process has exited and inspect the pending transaction. Rebuild contract artifacts before a new release. Existing immutable deployments are verified against those artifacts rather than replaced.
