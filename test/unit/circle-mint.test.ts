import { describe, expect, it, vi } from 'vitest';
import { CircleMintSandbox } from '@testnet/circle-mint';
import {
  circle_receipt_received,
  usdc_atomic,
  usdc_decimal,
} from '@testnet/circle-funding';
import { NEAR_TESTNET_USDC } from '@kanso/bindings';
import type { Release } from '@testnet/deployment';

function journal() {
  return {
    journal: { effects: {}, contracts: {} },
    save: vi.fn(async () => undefined),
  } as unknown as Release;
}

describe('Circle Mint sandbox funding requests', () => {
  const key = 'SAND_API_KEY:test';

  it('rejects production credentials and non-sandbox API paths', async () => {
    expect(() => new CircleMintSandbox('LIVE_API_KEY:test')).toThrow(
      'sandbox API key',
    );
    const send = vi.fn();
    const circle = new CircleMintSandbox(key, send);
    await expect(
      circle.request('https://other.example/v1/configuration'),
    ).rejects.toThrow('Invalid Circle sandbox API path');
    expect(send).not.toHaveBeenCalled();
  });

  it('pins authenticated requests to the sandbox and refuses redirects', async () => {
    const send = vi.fn(async () => Response.json({ data: { ready: true } }));
    const circle = new CircleMintSandbox(key, send);
    expect(await circle.request('/v1/configuration')).toEqual({ ready: true });
    expect(send).toHaveBeenCalledWith(
      'https://api-sandbox.circle.com/v1/configuration',
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        redirect: 'error',
      }),
    );
  });

  it('persists a stable idempotency key before submission and reuses it after a timeout', async () => {
    const release = journal();
    const send = vi.fn(async () => {
      expect(release.save).toHaveBeenCalled();
      throw new Error('Connection lost');
    });
    const circle = new CircleMintSandbox(key, send);
    const body = { address: 'lp.testnet', chain: 'NEAR', currency: 'USD' };
    await expect(
      circle.post(release, 'recipient', '/v1/recipients', body),
    ).rejects.toThrow('Connection lost');
    await expect(
      circle.post(release, 'recipient', '/v1/recipients', body),
    ).rejects.toThrow('Connection lost');
    expect(
      send.mock.calls.map(
        (call) =>
          JSON.parse(
            (call as unknown as [string, RequestInit])[1].body as string,
          ).idempotencyKey,
      ),
    ).toEqual([
      release.journal.effects.recipient!.transaction_id,
      release.journal.effects.recipient!.transaction_id,
    ]);
    expect(JSON.stringify(release.journal)).not.toContain(key);
    await expect(
      circle.post(release, 'recipient', '/v1/recipients', {
        ...body,
        address: 'other.testnet',
      }),
    ).rejects.toThrow('request changed');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not resubmit a mock wire deposit after an ambiguous response', async () => {
    const release = journal();
    const send = vi.fn(async () => {
      throw new Error('Connection lost');
    });
    const circle = new CircleMintSandbox(key, send);
    await expect(
      circle.post(
        release,
        'deposit',
        '/v1/mocks/payments/wire',
        { amount: '100' },
        false,
      ),
    ).rejects.toThrow('Connection lost');
    await expect(
      circle.post(
        release,
        'deposit',
        '/v1/mocks/payments/wire',
        { amount: '100' },
        false,
      ),
    ).rejects.toThrow('Reconcile');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reuses an accepted deposit response without submitting again', async () => {
    const release = journal();
    const send = vi.fn(async () =>
      Response.json({ data: { status: 'pending' } }),
    );
    const circle = new CircleMintSandbox(key, send);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        await circle.post(
          release,
          'deposit',
          '/v1/mocks/payments/wire',
          { amount: '100' },
          false,
        ),
      ).toEqual({ status: 'pending' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Circle withdrawal verification', () => {
  it('preserves large USDC amounts and rejects fractional precision loss', () => {
    expect(usdc_atomic('10000000')).toBe(10_000_000_000_000n);
    const amount = '9007199254740993.123456';
    expect(usdc_decimal(usdc_atomic(amount))).toBe(amount);
    expect(usdc_atomic('0.000001')).toBe(1n);
    for (const invalid of ['-1', '1e7', '01', '0.0000001', '1.'])
      expect(() => usdc_atomic(invalid)).toThrow();
  });

  function receipt(
    event = 'ft_transfer',
    executor_id = NEAR_TESTNET_USDC,
  ): Parameters<typeof circle_receipt_received>[0] {
    return {
      final_execution_status: 'FINAL',
      status: { SuccessValue: '' },
      receipts_outcome: [
        {
          outcome: {
            executor_id,
            status: { SuccessValue: '' },
            logs: [
              `EVENT_JSON:${JSON.stringify({ standard: 'nep141', event, data: [{ ...(event === 'ft_mint' ? { owner_id: 'lp.testnet' } : { new_owner_id: 'lp.testnet' }), amount: '1000000' }] })}`,
            ],
          },
        },
      ],
    };
  }

  it('accepts finalized transfers or mints from the exact Circle token', () => {
    for (const event of ['ft_transfer', 'ft_mint'])
      expect(
        circle_receipt_received(receipt(event), 'lp.testnet', '1000000'),
      ).toBe(true);
  });

  it('rejects the wrong token, recipient, amount, event or finality', () => {
    expect(
      circle_receipt_received(
        receipt('ft_transfer', 'other.testnet'),
        'lp.testnet',
        '1000000',
      ),
    ).toBe(false);
    expect(
      circle_receipt_received(receipt(), 'solver.testnet', '1000000'),
    ).toBe(false);
    expect(circle_receipt_received(receipt(), 'lp.testnet', '1000001')).toBe(
      false,
    );
    expect(
      circle_receipt_received(receipt('ft_burn'), 'lp.testnet', '1000000'),
    ).toBe(false);
    expect(
      circle_receipt_received(
        { ...receipt(), final_execution_status: 'EXECUTED_OPTIMISTIC' },
        'lp.testnet',
        '1000000',
      ),
    ).toBe(false);
    expect(
      circle_receipt_received(
        { ...receipt(), status: {} },
        'lp.testnet',
        '1000000',
      ),
    ).toBe(false);
    const failed = receipt();
    failed.receipts_outcome[0]!.outcome.status = {};
    expect(circle_receipt_received(failed, 'lp.testnet', '1000000')).toBe(
      false,
    );
  });
});
