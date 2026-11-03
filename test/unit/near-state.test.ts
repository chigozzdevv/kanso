import { afterEach, describe, expect, it, vi } from 'vitest';
import * as network from '@testnet/network';
import {
  near_map_keys,
  read_batch,
  storage_key_fields,
} from '@testnet/near-state';

function key(prefix: string, ...fields: string[]) {
  return Buffer.concat([
    Buffer.from(prefix),
    ...fields.flatMap((value) => {
      const bytes = Buffer.from(value),
        length = Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      return [length, bytes];
    }),
  ]).toString('base64');
}

describe('legacy NEAR storage enumeration', () => {
  afterEach(() => vi.restoreAllMocks());
  it('paginates large state at one finalized block', async () => {
    const cursor = key('p', 'first');
    const read = vi
      .spyOn(network, 'rpc')
      .mockResolvedValueOnce({
        block_hash: 'final-block',
        values: [{ key: cursor }],
        last_key: cursor,
      })
      .mockResolvedValueOnce({
        block_hash: 'final-block',
        values: [{ key: key('p', 'second') }],
      });
    expect(await near_map_keys('coordinator.testnet', 'p')).toEqual([
      ['first'],
      ['second'],
    ]);
    expect(read.mock.calls[0]![2]).toMatchObject({
      finality: 'final',
      limit: 100,
    });
    expect(read.mock.calls[1]![2]).toMatchObject({
      block_id: 'final-block',
      after_key_base64: cursor,
      limit: 100,
    });
    expect(read.mock.calls[1]![2]).not.toHaveProperty('finality');
  });
  it('rejects a repeated cursor or a changed state snapshot', async () => {
    const cursor = key('p', 'first');
    const read = vi.spyOn(network, 'rpc').mockResolvedValue({
      block_hash: 'final-block',
      values: [{ key: cursor }],
      last_key: cursor,
    });
    await expect(near_map_keys('coordinator.testnet', 'p')).rejects.toThrow(
      'did not advance',
    );
    read
      .mockReset()
      .mockResolvedValueOnce({
        block_hash: 'one',
        values: [{ key: cursor }],
        last_key: cursor,
      })
      .mockResolvedValueOnce({ block_hash: 'two', values: [] });
    await expect(near_map_keys('coordinator.testnet', 'p')).rejects.toThrow(
      'snapshot changed',
    );
  });
  it('decodes pool and compound position keys without mixing overlapping prefixes', () => {
    expect(storage_key_fields(key('p', 'test-usdc'), 'p', 1)).toEqual([
      'test-usdc',
    ]);
    expect(
      storage_key_fields(key('s', 'test-usdc', 'lp.testnet'), 's', 2),
    ).toEqual(['test-usdc', 'lp.testnet']);
    expect(storage_key_fields(key('se', 'settlement'), 's', 2)).toBeNull();
    expect(storage_key_fields(key('tu', 'topup'), 't', 1)).toBeNull();
  });
  it('rejects truncated, oversized and trailing fields instead of inventing object identities', () => {
    const valid = Buffer.from(key('p', 'usdc'), 'base64');
    expect(
      storage_key_fields(valid.subarray(0, -1).toString('base64'), 'p', 1),
    ).toBeNull();
    expect(storage_key_fields(key('p', 'a'.repeat(65)), 'p', 1)).toBeNull();
    expect(storage_key_fields(key('p', 'usdc', 'extra'), 'p', 1)).toBeNull();
    expect(
      storage_key_fields(key('p', 'invalid/identifier'), 'p', 1),
    ).toBeNull();
  });
  it('keeps RPC reads ordered and bounded and propagates an incomplete audit', async () => {
    let active = 0,
      maximum = 0;
    const result = await read_batch([0, 1, 2, 3, 4, 5, 6], async (value) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return value * 2;
    });
    expect(result).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(maximum).toBeLessThanOrEqual(4);
    await expect(
      read_batch([1, 2], async (value) => {
        if (value === 2) throw new Error('RPC failed');
        return value;
      }),
    ).rejects.toThrow('RPC failed');
  });
});
