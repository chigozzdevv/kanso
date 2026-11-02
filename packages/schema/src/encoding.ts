import { loan_offer } from '@schema/offer';
import type { Offer } from '@schema/offer';

class Encoder {
  private readonly chunks: Uint8Array[] = [];

  integer(value: bigint, bytes: number): this {
    if (value < 0n || value >= 1n << BigInt(bytes * 8)) {
      throw new RangeError('Integer does not fit encoding');
    }
    const output = new Uint8Array(bytes);
    for (let index = 0; index < bytes; index += 1) {
      output[index] = Number(value & 255n);
      value >>= 8n;
    }
    this.chunks.push(output);
    return this;
  }

  text(value: string): this {
    const bytes = new TextEncoder().encode(value);
    this.integer(BigInt(bytes.length), 4);
    this.chunks.push(bytes);
    return this;
  }

  bytes(value: number[]): this {
    this.integer(BigInt(value.length), 4);
    this.chunks.push(Uint8Array.from(value));
    return this;
  }

  finish(): Uint8Array {
    const result = new Uint8Array(
      this.chunks.reduce((sum, chunk) => sum + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

export function encode_offer(input: Offer): Uint8Array {
  const offer = loan_offer.parse(input);
  const encoder = new Encoder()
    .text('kanso:offer')
    .integer(2n, 2)
    .text(offer.deployment_id)
    .integer(offer.network === 'sandbox' ? 0n : 1n, 1)
    .text(offer.offer_id)
    .text(offer.pool_id)
    .text(offer.borrower)
    .text(offer.payout_account)
    .integer(BigInt(offer.policy_version), 4)
    .integer(BigInt(offer.principal_atomic), 16)
    .integer(BigInt(offer.apr_bps), 2)
    .integer(BigInt(offer.duration_seconds), 8)
    .integer(BigInt(offer.origination_fee_atomic), 16)
    .integer(BigInt(offer.expires_at), 8)
    .integer(BigInt(offer.setup_deadline), 8)
    .integer(BigInt(offer.min_price_atomic), 16)
    .integer(BigInt(offer.max_price_atomic), 16)
    .integer(BigInt(offer.legs.length), 4);
  for (const leg of offer.legs) {
    encoder
      .text(leg.asset_id)
      .integer(leg.custody.family === 'near' ? 0n : 1n, 1);
    if (leg.custody.family === 'remote') {
      const source = leg.custody;
      encoder
        .text(source.chain_id)
        .integer(BigInt(source.manifest_version), 4)
        .integer(BigInt(source.min_price_atomic), 16)
        .integer(BigInt(source.max_price_atomic), 16)
        .bytes(source.lock_id)
        .bytes(source.source_owner)
        .bytes(source.release_recipient);
    }
    encoder
      .text(leg.leg_id)
      .text(leg.owner)
      .integer(BigInt(leg.amount_atomic), 16)
      .text(leg.release_recipient);
  }
  return encoder.finish();
}
