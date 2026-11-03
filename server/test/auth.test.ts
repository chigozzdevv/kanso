import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Account, RpcProvider, typedData, ec } from 'starknet';
import { starknet_auth_message } from '@kanso/sdk';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { address, networks } from 'bitcoinjs-lib';
import { auth_challenge, deployment } from '@kanso/schema';
import type { ChainFamily } from '@kanso/schema';
import { verify_ownership } from '@server/features/auth/auth.proof';
const d = deployment.parse({
  deployment_id: 'proof_tests',
  network: 'sandbox',
  near: {
    rpc_url: 'http://localhost:1',
    coordinator: 'kanso.near',
    settlement_token: 'usdc.near',
    settlement_decimals: 6,
  },
  pool_ids: [],
  chains: [],
});
const challenge = (family: ChainFamily, address: string) =>
  auth_challenge.parse({
    challenge_id: 'ownership',
    deployment_id: d.deployment_id,
    domain: 'localhost',
    purpose: 'link_wallet',
    family,
    chain_id: family === 'evm' ? 'base' : family,
    address,
    message: 'Kanso ownership proof\nNonce: 5c6b0037\nOwner: borrower.near',
    nonce: '07'.repeat(32),
    expires_at: 2000000000,
  });
describe('source wallet ownership verification with actual wallet signatures', () => {
  it('signs complete SNIP-12 challenges with newlines, control bytes and Unicode', async () => {
    const secret = '0x1234567';
    const account = new Account({
      provider: new RpcProvider({ nodeUrl: 'http://localhost:1' }),
      address: '0x1234',
      signer: secret,
    });
    const message =
      challenge('starknet', account.address).message + '\né🚀\u0000';
    const data = starknet_auth_message(message);
    expect(JSON.parse(data.message.challenge)).toBe(message);
    const signed = await account.signMessage(data);
    const signature = Array.isArray(signed)
      ? new ec.starkCurve.Signature(BigInt(signed[0]!), BigInt(signed[1]!))
      : signed;
    const hash = typedData.getMessageHash(data, account.address);
    expect(
      ec.starkCurve.verify(signature, hash, ec.starkCurve.getPublicKey(secret)),
    ).toBe(true);
    for (const changed of [message.replace('\n', ''), message + 'changed']) {
      const changed_hash = typedData.getMessageHash(
        starknet_auth_message(changed),
        account.address,
      );
      expect(changed_hash).not.toBe(hash);
      expect(
        ec.starkCurve.verify(
          signature,
          changed_hash,
          ec.starkCurve.getPublicKey(secret),
        ),
      ).toBe(false);
    }
  });
  it('verifies EIP-191 and rejects a different message or account', async () => {
    const wallet = privateKeyToAccount(
        ('0x' + '07'.repeat(32)) as `0x${string}`,
      ),
      c = challenge('evm', wallet.address),
      p = {
        challenge_id: c.challenge_id,
        signature: await wallet.signMessage({ message: c.message }),
      };
    expect(await verify_ownership(d, c, p)).toBe(true);
    expect(
      await verify_ownership(d, { ...c, message: c.message + 'changed' }, p),
    ).toBe(false);
    expect(
      await verify_ownership(d, { ...c, address: '0x' + '08'.repeat(20) }, p),
    ).toBe(false);
  });
  it('verifies Ed25519 wallet messages and preserves Solana account case', async () => {
    const secret = new Uint8Array(32).fill(9),
      address = bs58.encode(ed25519.getPublicKey(secret)),
      c = challenge('solana', address),
      p = {
        challenge_id: c.challenge_id,
        signature: bs58.encode(
          ed25519.sign(new TextEncoder().encode(c.message), secret),
        ),
      };
    expect(await verify_ownership(d, c, p)).toBe(true);
    expect(
      await verify_ownership(d, { ...c, address: address.toLowerCase() }, p),
    ).toBe(false);
    expect(
      await verify_ownership(d, { ...c, message: c.message + 'changed' }, p),
    ).toBe(false);
  });
  it('accepts the official BIP-322 P2WPKH vector with current and legacy simple encoding', async () => {
    // https://github.com/bitcoin/bips/blob/master/bip-0322/basic-test-vectors.json
    const destination = address.fromOutputScript(
      address.toOutputScript(
        'bc1q9vza2e8x573nczrlzms0wvx3gsqjx7vavgkx0l',
        networks.bitcoin,
      ),
      networks.testnet,
    );
    const c = { ...challenge('bitcoin', destination), message: '' };
    const signature =
      'smpAkcwRAIgM2gBAQqvZX15ZiysmKmQpDrG83avLIT492QBzLnQIxYCIBaTpOaD20qRlEylyxFSeEA2ba9YOixpX8z46TSDtS40ASECx/EgAxlkQpQ9hYjgGu6EBCPMVPwVIVJqO4XCsMvViHI=';
    expect(
      await verify_ownership(d, c, { challenge_id: c.challenge_id, signature }),
    ).toBe(true);
    expect(
      await verify_ownership(d, c, {
        challenge_id: c.challenge_id,
        signature: signature.slice(3),
      }),
    ).toBe(true);
    expect(
      await verify_ownership(
        d,
        { ...c, message: 'changed' },
        { challenge_id: c.challenge_id, signature },
      ),
    ).toBe(false);
    expect(
      await verify_ownership(d, c, {
        challenge_id: c.challenge_id,
        signature: 'ful' + signature.slice(3),
      }),
    ).toBe(false);
  });
  it('verifies Sui personal-message intent signatures and rejects another address', async () => {
    const wallet = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(11)),
      c = challenge('sui', wallet.toSuiAddress()),
      signed = await wallet.signPersonalMessage(
        new TextEncoder().encode(c.message),
      ),
      p = { challenge_id: c.challenge_id, signature: signed.signature };
    expect(await verify_ownership(d, c, p)).toBe(true);
    expect(
      await verify_ownership(d, { ...c, address: '0x' + '08'.repeat(32) }, p),
    ).toBe(false);
    expect(
      await verify_ownership(d, { ...c, message: c.message + 'changed' }, p),
    ).toBe(false);
  });
});
