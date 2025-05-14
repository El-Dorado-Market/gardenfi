import type { Transaction } from 'bitcoinjs-lib';
import type { Result } from '@gardenfi/utils';
import { btcProvider, btcWallet } from '../src/btc';
import { createBtcRedeemTx, signBtcRedeemTx } from '../src/btcRedeem';

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
const receiver = process.env.BTC_RECIPIENT_ADDRESS;
if (!receiver) {
  throw new Error('BTC_RECIPIENT_ADDRESS is not set');
}
const redeemerAddress = process.env.REDEEMER_ADDRESS;
if (!redeemerAddress) {
  throw new Error('REDEEMER_ADDRESS is not set');
}
const secret = process.env.SECRET;
if (!secret) {
  throw new Error('SECRET is not set');
}
const secretHash = process.env.SECRET_HASH;
if (!secretHash) {
  throw new Error('SECRET_HASH is not set');
}

createBtcRedeemTx({
  expiry,
  initiatorAddress,
  receiver,
  redeemerAddress,
  secret,
  secretHash,
})
  .then<Result<Transaction, string>>((result) => {
    if (!result.ok) {
      return result;
    }
    const { val: props } = result;
    return signBtcRedeemTx({ ...props, signer: btcWallet }).then((tx) => {
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
