import type { Result } from '@gardenfi/utils';
import * as bitcoin from 'bitcoinjs-lib';
import {
  btcNetwork,
  btcProvider,
  btcWallet,
  buildTx,
  generateAddress,
  generateControlBlockFor,
  generateInternalPubkey,
  generateOutputScripts,
  getFee,
  getLeafHash,
  getLeaves,
  htlcErrors,
  redeemLeaf,
  type FeeRates,
} from './btc';
import { toXOnly } from '@gardenfi/core';
import type { BitcoinUTXO, BitcoinWallet } from '@catalogfi/wallets';
import { trim0x } from '@catalogfi/utils';
import type { Taptree } from 'bitcoinjs-lib/src/types';

export const createBtcRedeemTx = ({
  expiry,
  initiatorAddress,
  receiver,
  redeemerAddress,
  secret,
  secretHash,
}: {
  expiry: number;
  initiatorAddress: string;
  receiver: string;
  redeemerAddress: string;
  secret: string;
  secretHash: string;
}): Promise<Result<string, string>> => {
  const internalPubkeyResult = generateInternalPubkey();
  if (!internalPubkeyResult.ok) {
    return Promise.resolve(internalPubkeyResult);
  }
  const { val: internalPubkey } = internalPubkeyResult;
  const initiatorPubkey = toXOnly(initiatorAddress);
  const network = btcNetwork;
  const provider = btcProvider;
  const redeemerPubkey = toXOnly(redeemerAddress);
  const scriptTree: Taptree = getLeaves({
    expiry,
    initiatorPubkey,
    redeemerPubkey,
    secretHash,
  });
  const addressResult = generateAddress({
    internalPubkey,
    network,
    scriptTree,
  });
  if (!addressResult.ok) {
    return Promise.resolve(addressResult);
  }
  const { val: address } = addressResult;
  const trimmedSecret = trim0x(secret);
  if (
    secretHash !==
    bitcoin.crypto.sha256(Buffer.from(trimmedSecret, 'hex')).toString('hex')
  ) {
    return Promise.resolve({
      error: htlcErrors.secretMismatch,
      ok: false,
    });
  }
  return Promise.all([provider.getFeeRates(), provider.getUTXOs(address)])
    .then<
      Result<
        {
          address: string;
          feeRates: FeeRates;
          scriptTree: Taptree;
          utxos: Array<BitcoinUTXO>;
        },
        string
      >
    >(([feeRates, utxos]) => {
      return {
        ok: true,
        val: {
          address,
          feeRates,
          scriptTree,
          utxos,
        },
      };
    })
    .then<Result<SignRedeemTxProps, string>>((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { address, feeRates, scriptTree, utxos },
      } = result;
      const leafScript = redeemLeaf({ redeemerPubkey, secretHash });
      const controlBlockResult = generateControlBlockFor({
        internalPubkey,
        leafScript,
        network,
        scriptTree,
      });
      if (!controlBlockResult.ok) {
        return controlBlockResult;
      }
      const { val: controlBlock } = controlBlockResult;
      const hashType = bitcoin.Transaction.SIGHASH_DEFAULT;
      const leafHash = getLeafHash({ leafScript });
      const outputScripts = generateOutputScripts({
        address,
        count: utxos.length,
        network,
      });
      const signer = btcWallet;
      const tempTx = buildTx({
        fee: 0,
        network,
        receiver,
        tx: new bitcoin.Transaction(),
        utxos,
      });
      const values = utxos.map((utxo) => {
        return utxo.value;
      });
      const signTxProps: SignRedeemTxProps = {
        controlBlock,
        hashType,
        leafHash,
        leafScript,
        outputScripts,
        secret: trimmedSecret,
        signer,
        tx: tempTx,
        values,
      };
      return signRedeemTx(signTxProps).then((tx) => {
        return {
          ok: true,
          val: {
            ...signTxProps,
            tx: buildTx({
              fee: getFee({ feeRates, vSize: tx.virtualSize() }),
              network,
              receiver,
              utxos,
              tx: new bitcoin.Transaction(),
            }),
          },
        };
      });
    })
    .then((result) => {
      if (!result.ok) {
        return result;
      }
      const { val: signTxProps } = result;
      return signRedeemTx(signTxProps).then((tx) => {
        return {
          ok: true,
          val: tx.toHex(),
        };
      });
    });
};

export type SignRedeemTxProps = {
  controlBlock: Buffer;
  hashType: number;
  leafHash: Buffer;
  leafScript: Buffer;
  outputScripts: Array<Buffer>;
  secret: string;
  signer: BitcoinWallet;
  tx: bitcoin.Transaction;
  values: Array<number>;
};
export const signRedeemTx = ({
  controlBlock,
  hashType,
  leafHash,
  leafScript,
  outputScripts,
  secret,
  signer,
  tx,
  values,
}: SignRedeemTxProps): Promise<bitcoin.Transaction> => {
  const secretBuffer = Buffer.from(secret, 'hex');
  return Promise.all(
    tx.ins.map((_, i) => {
      const hash = tx.hashForWitnessV1(
        i,
        outputScripts,
        values,
        hashType,
        leafHash,
      );
      return signer.signSchnorr(hash).then((signature) => {
        tx.setWitness(i, [signature, secretBuffer, leafScript, controlBlock]);
      });
    }),
  ).then(() => {
    return tx;
  });
};
