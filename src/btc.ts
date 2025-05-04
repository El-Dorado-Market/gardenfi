import * as secp256k1 from 'tiny-secp256k1';
import {
  BitcoinNetwork,
  BitcoinProvider,
  BitcoinWallet,
} from '@catalogfi/wallets';
import { digestKey } from './utils';
import { toXOnly } from '@gardenfi/core';
import type { Result } from '@gardenfi/utils';
import * as bitcoin from 'bitcoinjs-lib';

export const provider = new BitcoinProvider(BitcoinNetwork.Mainnet);
export const btcWallet = BitcoinWallet.fromPrivateKey(
  digestKey.digestKey,
  provider,
);

export const getBtcAddress = (): Promise<Result<string, string>> => {
  return btcWallet.getPublicKey().then((pubKey) => {
    if (!pubKey || !isValidBitcoinPubKey({ pubKey })) {
      return { error: 'Invalid btc public key', ok: false };
    }
    return { ok: true, val: toXOnly(pubKey) };
  });
};

export const getBtcNetwork = () => {
  return bitcoin.networks.bitcoin;
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
