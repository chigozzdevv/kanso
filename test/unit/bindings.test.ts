import { describe, expect, it } from 'vitest';
import { assert_public_change, coordinator_methods } from '@kanso/bindings';

describe('contract binding mutation boundaries', () => {
  it('uses actual exported contract mutations and excludes constructors, callbacks and views', () => {
    expect(coordinator_methods.create_pool).toBeDefined();
    expect(() => assert_public_change('create_pool')).not.toThrow();
    for (const name of [
      'new',
      'get_config',
      'record_transfer_outcome',
      'totally_unknown',
    ])
      expect(() => assert_public_change(name)).toThrow();
  });
});
