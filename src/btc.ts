import * as secp256k1 from 'tiny-secp256k1';
import {
  BitcoinNetwork,
  BitcoinProvider,
  BitcoinWallet,
} from '@catalogfi/wallets';
import { digestKey } from './utils';
import { Err, Ok } from '@catalogfi/utils';
import { toXOnly } from '@gardenfi/core';

export const provider = new BitcoinProvider(BitcoinNetwork.Mainnet);

export const btcWallet = BitcoinWallet.fromPrivateKey(
  digestKey.digestKey,
  provider,
);

export const getBtcAddress = () => {
  return btcWallet.getPublicKey().then((pubKey) => {
    if (!pubKey || !isValidBitcoinPubKey({ pubKey })) {
      return Err('Invalid btc public key');
    }
    return Ok(toXOnly(pubKey));
  });
};

export const isValidBitcoinPubKey = ({
  pubKey,
}: { pubKey: string }): boolean => {
  if (!pubKey) {
    return false;
  }

  try {
    const pubKeyBuffer = Buffer.from(pubKey, 'hex');
    return secp256k1.isPoint(pubKeyBuffer);
  } catch {
    return false;
  }
};
