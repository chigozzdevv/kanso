import { afterEach, describe, expect, it, vi } from 'vitest';
import { evmChoices } from '@client/lib/wallets/evm';
import { bitcoinChoices } from '@client/lib/wallets/bitcoin';
import { nearBalance } from '@client/lib/wallets/near';

afterEach(() => vi.unstubAllGlobals());

describe('NEAR wallet balances', () => {
  const implicit = '31'.repeat(32);
  const missingAccount = (account: string) => ({
    error: {
      code: -32000,
      message: 'Server error',
      cause: {
        name: 'UNKNOWN_ACCOUNT',
        info: { requested_account_id: account },
      },
    },
  });

  it('shows zero before an implicit account is funded and reads its balance after funding', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(Response.json(missingAccount(implicit)))
      .mockResolvedValueOnce(
        Response.json({
          result: {
            amount: '2000000000000000000000000',
            locked: '0',
            storage_usage: 182,
          },
        }),
      );
    vi.stubGlobal('fetch', send);
    expect(await nearBalance(implicit)).toBe('0');
    expect(await nearBalance(implicit)).toBe('1998180000000000000000000');
    expect(JSON.parse(send.mock.calls[0]![1].body).params).toEqual({
      request_type: 'view_account',
      finality: 'final',
      account_id: implicit,
    });
  });

  it('never reports a negative balance when storage costs exceed the amount', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({
        result: { amount: '1000', locked: '0', storage_usage: 182 },
      }),
    );
    expect(await nearBalance(implicit)).toBe('0');
  });

  it.each([
    [implicit, { error: { cause: { name: 'NO_SYNCED_BLOCKS' } } }],
    [implicit, missingAccount('42'.repeat(32))],
    ['missing.testnet', missingAccount('missing.testnet')],
  ])('does not mask unrelated RPC errors for %s', async (account, result) => {
    vi.stubGlobal('fetch', async () => Response.json(result));
    await expect(nearBalance(account)).rejects.toMatchObject({
      code: 'RPC_UNAVAILABLE',
    });
  });

  it('does not report zero when the RPC transport fails', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(nearBalance(implicit)).rejects.toMatchObject({
      code: 'RPC_UNAVAILABLE',
    });
  });
});

describe('browser wallet network and amount boundaries', () => {
  it('switches EVM networks and preserves atomic values above Number.MAX_SAFE_INTEGER', async () => {
    const account = '0x1111111111111111111111111111111111111111';
    let chain = '0x1';
    const request = vi.fn(
      async (input: { method: string; params?: unknown[] }) => {
        switch (input.method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [account];
          case 'eth_chainId':
            return chain;
          case 'wallet_switchEthereumChain':
            chain = (input.params![0] as { chainId: string }).chainId;
            return null;
          case 'eth_sendTransaction':
            return '0xsubmitted';
          default:
            throw new Error('Unexpected wallet request');
        }
      },
    );
    const target = new EventTarget();
    vi.stubGlobal('window', Object.assign(target, { ethereum: { request } }));
    const wallet = await evmChoices()[0]!.connect();
    if (wallet.port.family !== 'evm') throw new Error('Expected EVM port');
    expect(await wallet.port.network('base')).toBe('84532');
    await wallet.port.send_transaction({
      family: 'evm',
      chain_id: 'base',
      signer_id: account,
      to: account,
      data: '0x',
      value: '9007199254740993',
    });
    expect(request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x14a34' }],
    });
    expect(request).toHaveBeenCalledWith({
      method: 'eth_sendTransaction',
      params: [
        { from: account, to: account, data: '0x', value: '0x20000000000001' },
      ],
    });
    expect(
      (await wallet.port.accounts()).map((entry) => entry.chain_id),
    ).toEqual(['base', 'arbitrum', 'bnb', 'polygon', 'avalanche', 'hyperevm']);
  });

  it('does not treat Bitcoin Testnet4 as Testnet3 when a switch was ignored', async () => {
    const getChain = vi.fn(async () => ({ enum: 'BITCOIN_TESTNET4' }));
    const switchChain = vi.fn(async () => undefined);
    const requestAccounts = vi.fn();
    vi.stubGlobal('window', {
      unisat: { getChain, switchChain, requestAccounts },
    });
    await expect(bitcoinChoices()[0]!.connect()).rejects.toThrow(
      'Bitcoin Testnet3',
    );
    expect(switchChain).toHaveBeenCalledWith('BITCOIN_TESTNET');
    expect(requestAccounts).not.toHaveBeenCalled();
  });

  it('refuses Bitcoin amounts that the wallet API cannot represent exactly', async () => {
    const sendBitcoin = vi.fn();
    vi.stubGlobal('window', {
      unisat: {
        getChain: async () => ({ enum: 'BITCOIN_TESTNET' }),
        requestAccounts: async () => ['tb1qtest'],
        sendBitcoin,
      },
    });
    const wallet = await bitcoinChoices()[0]!.connect();
    if (wallet.port.family !== 'bitcoin')
      throw new Error('Expected Bitcoin port');
    await expect(
      wallet.port.send_transaction({
        family: 'bitcoin',
        chain_id: 'bitcoin',
        signer_id: wallet.address,
        address: wallet.address,
        amount_atomic: '9007199254740993',
        script: '0x0014',
      }),
    ).rejects.toThrow('wallet limit');
    expect(sendBitcoin).not.toHaveBeenCalled();
  });
});
