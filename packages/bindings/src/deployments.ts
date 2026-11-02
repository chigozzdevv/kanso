import { deployment, KansoError } from '@kanso/schema';
import type { Deployment, ChainConfiguration } from '@kanso/schema';
export function parse_deployment(input: unknown): Deployment {
  return deployment.parse(input);
}
export function configured_chain(
  d: Deployment,
  id: string,
): ChainConfiguration {
  const c = d.chains.find((x) => x.manifest.chain_id === id);
  if (!c)
    throw new KansoError(
      'CAPABILITY_DISABLED',
      `Chain ${id} is not configured`,
    );
  return c;
}
export function executable_chain(
  d: Deployment,
  id: string,
): ChainConfiguration {
  const c = configured_chain(d, id);
  if (
    !c.manifest.new_locks_enabled ||
    !c.manifest.signing_enabled ||
    !c.evidence
  )
    throw new KansoError(
      'CAPABILITY_DISABLED',
      `Chain ${id} has no verified execution capability`,
    );
  return c;
}
