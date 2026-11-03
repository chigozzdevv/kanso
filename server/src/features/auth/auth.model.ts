import { Schema } from 'mongoose';
import type { Connection, Model } from 'mongoose';
import type { AuthChallenge } from '@kanso/schema';
export interface ChallengeDocument {
  _id: string;
  challenge: AuthChallenge;
  owner: string | null;
  used: boolean;
  expires_at: Date;
}
export interface SessionDocument {
  _id: string;
  account_id: string;
  deployment_id: string;
  expires_at: Date;
}
export interface LinkDocument {
  _id: string;
  owner: string;
  deployment_id: string;
  family: string;
  chain_id: string;
  address: string;
}
export function auth_models(c: Connection) {
  const challenge = new Schema<ChallengeDocument>(
    {
      _id: String,
      challenge: Schema.Types.Mixed,
      owner: String,
      used: Boolean,
      expires_at: Date,
    },
    { versionKey: false },
  );
  challenge.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
  const session = new Schema<SessionDocument>(
    {
      _id: String,
      account_id: String,
      deployment_id: String,
      expires_at: Date,
    },
    { versionKey: false },
  );
  session.index({ expires_at: 1 }, { expireAfterSeconds: 0 });
  const link = new Schema<LinkDocument>(
    {
      _id: String,
      owner: String,
      deployment_id: String,
      family: String,
      chain_id: String,
      address: String,
    },
    { versionKey: false },
  );
  link.index(
    { owner: 1, deployment_id: 1, chain_id: 1, address: 1 },
    { unique: true },
  );
  return {
    challenges:
      (c.models.Challenge as Model<ChallengeDocument>) ??
      c.model('Challenge', challenge),
    sessions:
      (c.models.Session as Model<SessionDocument>) ??
      c.model('Session', session),
    links:
      (c.models.WalletLink as Model<LinkDocument>) ??
      c.model('WalletLink', link),
  };
}
