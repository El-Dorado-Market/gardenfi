import * as ecc from 'tiny-secp256k1';
import { Err, type Result } from '@gardenfi/utils';
import { btcProvider, getHdKey } from '../src/btc';
import { createBtcRefundTx, signBtcRefundTx } from '../src/btcRefund';
import type { Transaction } from 'bitcoinjs-lib';

const expiryBlocks = process.env.EXPIRY_BLOCKS;
const expiry = expiryBlocks && Number.parseInt(expiryBlocks);
if (!expiry) {
  throw new Error(
    'EXPIRY_BLOCKS "' + expiryBlocks + '" is not a valid integer',
  );
}
const initiatorAddress = process.env.INITIATOR_ADDRESS;
if (!initiatorAddress) {
  throw new Error('INITIATOR_ADDRESS is not set');
}
const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC is not set');
}
const receiver = process.env.BTC_RECIPIENT_ADDRESS;
if (!receiver) {
  throw new Error('BTC_RECIPIENT_ADDRESS is not set');
}
const redeemerAddress = process.env.REDEEMER_ADDRESS;
if (!redeemerAddress) {
  throw new Error('REDEEMER_ADDRESS is not set');
}
const secretHash = process.env.SECRET_HASH;
if (!secretHash) {
  throw new Error('SECRET_HASH is not set');
}

getHdKey({ mnemonic })
  .then((hdKey) => {
    const { privateKey } = hdKey;
    if (!privateKey) {
      return Err('Failed to derive private key');
    }
    return createBtcRefundTx({
      expiry,
      initiatorAddress,
      receiver,
      redeemerAddress,
      secretHash,
      sign: (hash) => {
        return Buffer.from(ecc.signSchnorr(hash, privateKey));
      },
    });
  })
  .then<Result<Transaction, string>>((result) => {
    if (!result.ok) {
      return result;
    }
    const { val: props } = result;
    return signBtcRefundTx(props).then((tx) => {
      return { ok: true, val: tx };
    });
  })
  .then<Result<string, string>>((result) => {
    if (!result.ok) {
      return result;
    }
    const { val: tx } = result;
    return btcProvider.broadcast(tx.toHex()).then((hash) => {
      return { ok: true, val: hash };
    });
  })
  .then((result) => {
    console.dir(result, { depth: null });
  });
