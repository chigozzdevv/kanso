import NetworkNearProtocol from '@web3icons/react/icons/networks/NetworkNearProtocol';
import NetworkBitcoin from '@web3icons/react/icons/networks/NetworkBitcoin';
import NetworkSolana from '@web3icons/react/icons/networks/NetworkSolana';
import NetworkBase from '@web3icons/react/icons/networks/NetworkBase';
import NetworkArbitrumOne from '@web3icons/react/icons/networks/NetworkArbitrumOne';
import NetworkBinanceSmartChain from '@web3icons/react/icons/networks/NetworkBinanceSmartChain';
import NetworkPolygon from '@web3icons/react/icons/networks/NetworkPolygon';
import NetworkAvalanche from '@web3icons/react/icons/networks/NetworkAvalanche';
import NetworkHyperEvm from '@web3icons/react/icons/networks/NetworkHyperEvm';
import NetworkSui from '@web3icons/react/icons/networks/NetworkSui';
import NetworkStarknet from '@web3icons/react/icons/networks/NetworkStarknet';

const icons = {
  near: NetworkNearProtocol,
  bitcoin: NetworkBitcoin,
  solana: NetworkSolana,
  base: NetworkBase,
  arbitrum: NetworkArbitrumOne,
  bnb: NetworkBinanceSmartChain,
  polygon: NetworkPolygon,
  avalanche: NetworkAvalanche,
  hyperevm: NetworkHyperEvm,
  sui: NetworkSui,
  starknet: NetworkStarknet,
};

export type NetworkId = keyof typeof icons;

export function NetworkIcon({
  network,
  size = 28,
}: {
  network: NetworkId;
  size?: number;
}) {
  const Icon = icons[network];
  return <Icon size={size} variant="branded" aria-hidden="true" />;
}
