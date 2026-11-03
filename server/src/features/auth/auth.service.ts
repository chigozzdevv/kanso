import { randomBytes } from 'node:crypto';
import type { Connection } from 'mongoose';
import { KansoError, auth_challenge, near_account } from '@kanso/schema';
import type { Deployment, ChainFamily, OwnershipProof } from '@kanso/schema';
import { scoped_id, canonical_account } from '@kanso/sdk';
import { auth_models } from '@server/features/auth/auth.model';
import { verify_ownership } from '@server/features/auth/auth.proof';
export class AuthService {
  readonly models;
  constructor(
    private readonly db: Connection,
    private readonly d: Deployment,
    private readonly domain: string,
  ) {
    this.models = auth_models(db);
  }
  async initialize() {
    await Promise.all(Object.values(this.models).map((m) => m.init()));
  }
  async challenge(
    input: {
      family: ChainFamily;
      chain_id: string;
      address: string;
      purpose: 'login' | 'link_wallet';
    },
    owner?: string,
  ) {
    if (
      input.purpose === 'login' &&
      (input.family !== 'near' || input.chain_id !== 'near')
    )
      throw new KansoError(
        'INVALID_INPUT',
        'Log in with the NEAR account that owns the loan',
      );
    if (input.purpose === 'link_wallet' && !owner)
      throw new KansoError(
        'UNAUTHORIZED',
        'A NEAR session is required to link another wallet',
      );
    if (input.family === 'near') near_account.parse(input.address);
    else if (
      !this.d.chains.some(
        (c) =>
          c.manifest.chain_id === input.chain_id &&
          c.manifest.family === input.family,
      )
    )
      throw new KansoError('CAPABILITY_DISABLED', 'Unconfigured wallet chain');
    const now = Math.floor(Date.now() / 1000),
      nonce = randomBytes(32).toString('hex'),
      challenge_id = scoped_id(this.d.deployment_id, nonce);
    const message = `Kanso ownership proof\nDomain: ${this.domain}\nDeployment: ${this.d.deployment_id}\nPurpose: ${input.purpose}\nChain: ${input.chain_id}\nAccount: ${input.address}\nOwner: ${owner ?? input.address}\nNonce: ${nonce}\nExpires: ${now + 300}`;
    const c = auth_challenge.parse({
      ...input,
      challenge_id,
      deployment_id: this.d.deployment_id,
      domain: this.domain,
      nonce,
      message,
      expires_at: now + 300,
    });
    await this.models.challenges.create({
      _id: challenge_id,
      challenge: c,
      owner: owner ?? null,
      used: false,
      expires_at: new Date((now + 300) * 1000),
    });
    return c;
  }
  async verify(proof: OwnershipProof, owner?: string) {
    const row = await this.models.challenges
      .findOne({
        _id: proof.challenge_id,
        used: false,
        expires_at: { $gt: new Date() },
      })
      .lean();
    if (!row || row.challenge.deployment_id !== this.d.deployment_id)
      throw new KansoError('UNAUTHORIZED', 'Challenge expired or already used');
    const c = auth_challenge.parse(row.challenge);
    if (c.purpose === 'link_wallet' && (!owner || row.owner !== owner))
      throw new KansoError('FORBIDDEN', 'Wallet-link challenge owner mismatch');
    if (c.purpose === 'login' && owner)
      throw new KansoError(
        'INVALID_INPUT',
        'Use the login verification endpoint',
      );
    if (!(await verify_ownership(this.d, c, proof)))
      throw new KansoError('UNAUTHORIZED', 'Invalid ownership proof');
    const token = randomBytes(32).toString('base64url'),
      expiry = new Date(Date.now() + 3600000);
    await this.db.transaction(async (session) => {
      const updated = await this.models.challenges.updateOne(
        { _id: row._id, used: false, expires_at: { $gt: new Date() } },
        { $set: { used: true } },
        { session },
      );
      if (!updated.modifiedCount)
        throw new KansoError('UNAUTHORIZED', 'Challenge already consumed');
      if (c.purpose === 'login')
        await this.models.sessions.create(
          [
            {
              _id: scoped_id(token),
              account_id: c.address,
              deployment_id: this.d.deployment_id,
              expires_at: expiry,
            },
          ],
          { session },
        );
      else
        await this.models.links.updateOne(
          {
            _id: scoped_id(
              this.d.deployment_id,
              owner!,
              c.chain_id,
              canonical_account(c.family, c.address),
            ),
          },
          {
            $set: {
              owner: owner!,
              deployment_id: this.d.deployment_id,
              family: c.family,
              chain_id: c.chain_id,
              address: canonical_account(c.family, c.address),
            },
          },
          { upsert: true, session },
        );
    });
    return c.purpose === 'login'
      ? {
          token,
          expires_at: Math.floor(expiry.getTime() / 1000),
          account_id: c.address,
        }
      : { linked: true };
  }
  async authenticate(authorization: string | undefined): Promise<string> {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token)
      throw new KansoError('UNAUTHORIZED', 'A wallet session is required');
    const s = await this.models.sessions
      .findOne({
        _id: scoped_id(token),
        deployment_id: this.d.deployment_id,
        expires_at: { $gt: new Date() },
      })
      .lean();
    if (!s) throw new KansoError('UNAUTHORIZED', 'Session expired');
    return s.account_id;
  }
  async linked(owner: string, chain_id: string, address: string) {
    return !!(await this.models.links.exists({
      owner,
      deployment_id: this.d.deployment_id,
      chain_id,
      address: canonical_account(
        this.d.chains.find((c) => c.manifest.chain_id === chain_id)?.manifest
          .family ?? 'near',
        address,
      ),
    }));
  }
}
