import { randomUUID } from 'node:crypto';
import { digest } from '@testnet/deployment';
import type { Release } from '@testnet/deployment';
import { read_json } from '@testnet/store';
import type { KeyIndex } from '@testnet/store';

export class CircleMintSandbox {
  constructor(
    private readonly key = process.env.CIRCLE_MINT_SANDBOX_API_KEY ?? '',
    private readonly send: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (!key.startsWith('SAND_API_KEY:'))
      throw new Error('Configure a Circle Mint sandbox API key in root .env');
  }

  async request<T>(path: string, body?: object): Promise<T> {
    if (!/^\/v1\/[a-zA-Z0-9/_?=&.-]+$/.test(path))
      throw new Error('Invalid Circle sandbox API path');
    const response = await this.send(`https://api-sandbox.circle.com${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const result = (await response.json()) as {
      data?: T;
      code?: number;
      message?: string;
    };
    if (!response.ok)
      throw new Error(
        `Circle sandbox HTTP ${response.status}: ${result.code ?? ''} ${result.message ?? 'Request failed'}`,
      );
    if (result.data === undefined)
      throw new Error('Circle sandbox returned no data');
    return result.data;
  }

  async post<T>(
    release: Release,
    id: string,
    path: string,
    body: object,
    idempotent = true,
  ): Promise<T> {
    const intent = digest(JSON.stringify({ path, body }));
    let effect = release.journal.effects[id];
    if (effect && effect.intent !== intent)
      throw new Error(`Circle sandbox request changed: ${id}`);
    if (effect?.state === 'confirmed') return effect.result as T;
    if (effect && !idempotent)
      throw new Error(
        `Reconcile the existing Circle mock deposit before resubmitting: ${id}`,
      );
    if (!effect) {
      effect = {
        intent,
        state: 'prepared',
        transaction_id: randomUUID(),
        request: { path, body },
      };
      release.journal.effects[id] = effect;
      await release.save();
    }
    const result = await this.request<T>(
      path,
      idempotent ? { ...body, idempotencyKey: effect.transaction_id } : body,
    );
    effect.result = result;
    effect.state = 'confirmed';
    await release.save();
    return result;
  }
}

type Bank = { id: string; status: string; trackingRef?: string };
type Recipient = {
  id: string;
  address: string;
  chain: string;
  currency: string;
};
type FundingState = { wallet_id: string };

export async function circle_deposit_address(release: Release, chain: string) {
  if (!['NEAR', 'XLM'].includes(chain))
    throw new Error('Use NEAR or XLM for the sandbox USDC deposit address');
  const circle = new CircleMintSandbox();
  const configuration = await circle.request<{
    payments: { masterWalletId: string };
  }>('/v1/configuration');
  const state = release.journal.contracts.circle_mint as
    FundingState | undefined;
  if (!state || state.wallet_id !== configuration.payments.masterWalletId)
    throw new Error('Circle sandbox account differs from the funding journal');
  return circle.post<{
    id: string;
    address: string;
    addressTag?: string;
    chain: string;
    currency: string;
  }>(
    release,
    `circle-deposit-address-${chain.toLowerCase()}`,
    '/v1/businessAccount/wallets/addresses/deposit',
    { chain, currency: 'USD' },
  );
}

export async function circle_status() {
  const circle = new CircleMintSandbox();
  const [configuration, balances, recipients, deposits] = await Promise.all([
    circle.request('/v1/configuration'),
    circle.request('/v1/businessAccount/balances'),
    circle.request('/v1/businessAccount/wallets/addresses/recipient'),
    circle.request('/v1/businessAccount/deposits?pageSize=10'),
  ]);
  return {
    configuration,
    balances,
    recipients,
    deposits,
  };
}

export async function prepare_circle_funding(
  release: Release,
  amount: string,
  run: string,
) {
  if (!/^[a-z0-9-]{1,64}$/.test(run)) throw new Error('Invalid funding run');
  if (!/^[1-9]\d*(?:\.\d{1,2})?$/.test(amount))
    throw new Error('Use a positive USD sandbox deposit amount');
  const circle = new CircleMintSandbox();
  const configuration = await circle.request<{
    payments: { masterWalletId: string };
  }>('/v1/configuration');
  const wallet_id = configuration.payments.masterWalletId;
  const state = release.journal.contracts.circle_mint as
    FundingState | undefined;
  if (state && state.wallet_id !== wallet_id)
    throw new Error('Circle sandbox account changed');
  release.journal.contracts.circle_mint = { wallet_id };
  await release.save();

  // Circle's documented fictitious bank fixture is used only on its sandbox API.
  const bank = await circle.post<Bank>(
    release,
    'circle-sandbox-bank',
    '/v1/businessAccount/banks/wires',
    {
      accountNumber: '12340010',
      routingNumber: '121000248',
      billingDetails: {
        name: 'Satoshi Nakamoto',
        city: 'Boston',
        country: 'US',
        line1: '100 Money Street',
        district: 'MA',
        postalCode: '01234',
      },
      bankAddress: {
        bankName: 'WELLS FARGO BANK, NA',
        city: 'San Francisco',
        country: 'US',
        line1: '420 Montgomery Street',
        district: 'CA',
      },
    },
  );
  const instructions = await circle.request<{
    trackingRef: string;
    beneficiaryBank: { accountNumber: string };
  }>(`/v1/businessAccount/banks/wires/${bank.id}/instructions`);
  const deposit = await circle.post<{ status: string }>(
    release,
    `circle-deposit-${run}`,
    '/v1/mocks/payments/wire',
    {
      amount: { amount, currency: 'USD' },
      trackingRef: instructions.trackingRef,
      beneficiaryBank: {
        accountNumber: instructions.beneficiaryBank.accountNumber,
      },
    },
    false,
  );
  console.log(`Circle sandbox deposit ${amount} USDC: ${deposit.status}`);
  const index = await read_json<KeyIndex>(release.folder, 'index.json');
  for (const role of ['lp', 'solver']) {
    const wallet = index.wallets.find(
      (value) => value.family === 'near' && value.role === role,
    );
    if (!wallet || !wallet.address.endsWith('.testnet'))
      throw new Error(`Missing NEAR Testnet ${role} wallet`);
    const recipient = await circle.post<Recipient>(
      release,
      `circle-recipient-${role}`,
      '/v1/businessAccount/wallets/addresses/recipient',
      {
        address: wallet.address,
        chain: 'NEAR',
        currency: 'USD',
        description: `Kanso Testnet ${role}`,
      },
    );
    console.log(`NEAR ${role} recipient registered: ${recipient.id}`);
  }
  return circle_status();
}
