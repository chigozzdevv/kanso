import { operation_checkpoint, KansoError } from '@kanso/schema';
import type {
  Deployment,
  OperationCheckpoint,
  OperationSnapshot,
} from '@kanso/schema';
export function checkpoint(snapshot: OperationSnapshot): OperationCheckpoint {
  return operation_checkpoint.parse({
    version: 1,
    deployment_id: snapshot.deployment_id,
    network: snapshot.network,
    operation_id: snapshot.operation_id,
    owner: snapshot.owner,
    plan_hash: snapshot.plan_hash,
  });
}
export function validate_checkpoint(
  value: unknown,
  d: Deployment,
): OperationCheckpoint {
  const c = operation_checkpoint.parse(value);
  if (c.deployment_id !== d.deployment_id || c.network !== d.network)
    throw new KansoError(
      'NETWORK_MISMATCH',
      'Checkpoint belongs to another deployment',
    );
  return c;
}
