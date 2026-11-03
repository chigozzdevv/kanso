import TokenBTC from '@web3icons/react/icons/tokens/TokenBTC';
import TokenNEAR from '@web3icons/react/icons/tokens/TokenNEAR';
import TokenSOL from '@web3icons/react/icons/tokens/TokenSOL';
import TokenETH from '@web3icons/react/icons/tokens/TokenETH';
import TokenSUI from '@web3icons/react/icons/tokens/TokenSUI';
import TokenAVAX from '@web3icons/react/icons/tokens/TokenAVAX';
import TokenBNB from '@web3icons/react/icons/tokens/TokenBNB';
import TokenPOL from '@web3icons/react/icons/tokens/TokenPOL';
import TokenHYPE from '@web3icons/react/icons/tokens/TokenHYPE';
import NetworkStarknet from '@web3icons/react/icons/networks/NetworkStarknet';
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC';

const icons = {
  BTC: TokenBTC,
  NEAR: TokenNEAR,
  SOL: TokenSOL,
  ETH: TokenETH,
  SUI: TokenSUI,
  AVAX: TokenAVAX,
  BNB: TokenBNB,
  POL: TokenPOL,
  HYPE: TokenHYPE,
  STRK: NetworkStarknet,
  USDC: TokenUSDC,
};

export type TokenSymbol = keyof typeof icons;

export function isTokenSymbol(symbol: string): symbol is TokenSymbol {
  return Object.hasOwn(icons, symbol);
}

export function TokenIcon({
  symbol,
  size = 24,
}: {
  symbol: TokenSymbol;
  size?: number;
}) {
  const Icon = icons[symbol];
  return (
    <Icon
      size={size}
      variant={symbol === 'STRK' ? 'branded' : 'background'}
      style={{ borderRadius: '50%' }}
      aria-hidden="true"
    />
  );
}
