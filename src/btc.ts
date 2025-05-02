import {
  BitcoinNetwork,
  BitcoinProvider,
  BitcoinWallet,
} from '@catalogfi/wallets';
import { digestKey } from './utils';

export const provider = new BitcoinProvider(BitcoinNetwork.Mainnet);

export const btcWallet = BitcoinWallet.fromPrivateKey(
  digestKey.digestKey,
  provider,
);
