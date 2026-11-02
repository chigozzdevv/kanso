import { auth_challenge, session, KansoError } from '@kanso/schema';
import type { AuthChallenge, ChainFamily } from '@kanso/schema';
import type { HttpTransport } from '@sdk/transport/http';
import type { Wallets } from '@sdk/wallet/resolver';
export class Session {
  account_id: string | undefined;
  constructor(
    private readonly http: HttpTransport,
    private readonly wallets: Wallets,
    private readonly deployment_id: string,
    private readonly domain: string | undefined,
  ) {}
  private validate(
    c: AuthChallenge,
    family: ChainFamily,
    chain_id: string,
    address: string,
    purpose: AuthChallenge['purpose'],
    owner: string,
  ) {
    const now = Math.floor(Date.now() / 1000);
    const message = `Kanso ownership proof\nDomain: ${c.domain}\nDeployment: ${this.deployment_id}\nPurpose: ${purpose}\nChain: ${chain_id}\nAccount: ${address}\nOwner: ${owner}\nNonce: ${c.nonce}\nExpires: ${c.expires_at}`;
    if (
      c.deployment_id !== this.deployment_id ||
      c.domain !== this.domain ||
      c.family !== family ||
      c.chain_id !== chain_id ||
      c.address !== address ||
      c.purpose !== purpose ||
      c.expires_at <= now ||
      c.expires_at > now + 300 ||
      c.message !== message
    )
      throw new KansoError(
        'UNAUTHORIZED',
        'Ownership challenge differs from the selected account and application',
      );
  }
  async connect(account_id: string): Promise<void> {
    const wallet = await this.wallets.get('near', 'near', account_id);
    const challenge = auth_challenge.parse(
      await this.http.request('POST', '/v1/auth/challenge', {
        family: 'near',
        chain_id: 'near',
        address: account_id,
        purpose: 'login',
      }),
    );
    this.validate(challenge, 'near', 'near', account_id, 'login', account_id);
    const proof = await wallet.prove_ownership(challenge);
    const result = session.parse(
      await this.http.request('POST', '/v1/auth/verify', {
        challenge_id: challenge.challenge_id,
        ...proof,
      }),
    );
    if (result.account_id !== account_id)
      throw new KansoError('UNAUTHORIZED', 'Session owner mismatch');
    this.http.token = result.token;
    this.account_id = result.account_id;
  }
  async link(
    family: ChainFamily,
    chain_id: string,
    address: string,
  ): Promise<void> {
    const wallet = await this.wallets.get(family, chain_id, address);
    const c = auth_challenge.parse(
      await this.http.request('POST', '/v1/auth/challenge', {
        family,
        chain_id,
        address,
        purpose: 'link_wallet',
      }),
    );
    if (!this.account_id)
      throw new KansoError(
        'UNAUTHORIZED',
        'Connect the NEAR session before linking wallets',
      );
    this.validate(c, family, chain_id, address, 'link_wallet', this.account_id);
    await this.http.request('POST', '/v1/accounts/link', {
      challenge_id: c.challenge_id,
      ...(await wallet.prove_ownership(c)),
    });
  }
  disconnect(): void {
    this.http.token = undefined;
    this.account_id = undefined;
  }
}
