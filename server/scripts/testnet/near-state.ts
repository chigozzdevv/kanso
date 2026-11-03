import { NEAR_ARCHIVAL_RPC, rpc } from '@testnet/network';

export function storage_key_fields(
  key: string,
  prefix: string,
  fields: number,
) {
  const bytes = Buffer.from(key, 'base64');
  const start = Buffer.from(prefix);
  if (!bytes.subarray(0, start.length).equals(start)) return null;
  let offset = start.length;
  const result: string[] = [];
  for (let field = 0; field < fields; field++) {
    if (offset + 4 > bytes.length) return null;
    const length = bytes.readUInt32LE(offset);
    offset += 4;
    if (length < 1 || length > 64 || offset + length > bytes.length)
      return null;
    const value = bytes.subarray(offset, offset + length).toString('utf8');
    if (!/^[a-zA-Z0-9_.-]+$/.test(value)) return null;
    result.push(value);
    offset += length;
  }
  return offset === bytes.length ? result : null;
}

export async function near_map_keys(
  account_id: string,
  prefix: string,
  fields = 1,
) {
  const keys: string[][] = [];
  let block_id: string | undefined, after_key_base64: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const page = await rpc<{
      block_hash: string;
      values: { key: string }[];
      last_key?: string | null;
    }>(NEAR_ARCHIVAL_RPC, 'query', {
      request_type: 'view_state',
      ...(block_id ? { block_id } : { finality: 'final' }),
      account_id,
      prefix_base64: Buffer.from(prefix).toString('base64'),
      include_proof: false,
      limit: 100,
      ...(after_key_base64 ? { after_key_base64 } : {}),
    });
    if (!page.block_hash || (block_id && page.block_hash !== block_id))
      throw new Error('Storage audit snapshot changed between pages');
    block_id = page.block_hash;
    keys.push(
      ...page.values.flatMap(({ key }) => {
        const value = storage_key_fields(key, prefix, fields);
        return value ? [value] : [];
      }),
    );
    if (!page.last_key) return keys;
    if (cursors.has(page.last_key) || !page.values.length)
      throw new Error('Storage audit pagination did not advance');
    cursors.add(page.last_key);
    after_key_base64 = page.last_key;
  }
}

export async function read_batch<T, R>(
  items: T[],
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        result[index] = await read(items[index]!);
      }
    }),
  );
  return result;
}
