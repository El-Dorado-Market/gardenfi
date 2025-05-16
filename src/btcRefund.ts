import type { BitcoinProvider, BitcoinUTXO } from '@catalogfi/wallets';
import * as bitcoin from 'bitcoinjs-lib';
import { toXOnly } from '@gardenfi/core';
import type { Result } from '@gardenfi/utils';
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
  refundLeaf,
  type FeeRates,
  type Signer,
} from './btc';
import type { Taptree } from 'bitcoinjs-lib/src/types';

export const createBtcRefundTx = ({
  expiry,
  initiatorAddress,
  receiver,
  redeemerAddress,
  secretHash,
}: {
  expiry: number;
  initiatorAddress: string;
  receiver: string;
  redeemerAddress: string;
  secretHash: string;
}): Promise<Result<SignRefundTxProps, string>> => {
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
  return provider
    .getUTXOs(address)
    .then<Result<{ utxos: Array<BitcoinUTXO> }, string>>((utxos) => {
      return {
        ok: true,
        val: {
          utxos,
        },
      };
    })
    .then<
      Result<
        {
          blocksToExpiry: number;
          feeRates: FeeRates;
          utxos: Array<BitcoinUTXO>;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { utxos },
      } = result;
      return Promise.all([
        getBlocksToExpiry({ expiry, provider, utxos }),
        provider.getFeeRates(),
      ]).then(([blocksToExpiry, feeRates]) => {
        return {
          ok: true,
          val: {
            blocksToExpiry,
            feeRates,
            utxos,
          },
        };
      });
    })
    .then<Result<SignRefundTxProps, string>>((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { blocksToExpiry, feeRates, utxos },
      } = result;
      if (blocksToExpiry > 0) {
        return {
          error: htlcErrors.htlcNotExpired(blocksToExpiry),
          ok: false,
        };
      }
      const leafScript = refundLeaf({ expiry, initiatorPubkey });
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
        utxos,
        tx: new bitcoin.Transaction(),
      });
      const values = utxos.map((utxo) => {
        return utxo.value;
      });
      const signTxProps: SignRefundTxProps = {
        controlBlock,
        expiry,
        hashType,
        leafHash,
        leafScript,
        outputScripts,
        tx: tempTx,
        values,
      };
      return signBtcRefundTx({ ...signTxProps, signer }).then((tx) => {
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
    });
};

export const getBlocksToExpiry = ({
  expiry,
  provider,
  utxos,
}: {
  expiry: number;
  provider: BitcoinProvider;
  utxos: Array<BitcoinUTXO>;
}): Promise<number> => {
  return provider.getLatestTip().then((currentBlockHeight) => {
    return utxos.reduce((maxBlocksToExpiry, utxo) => {
      const blocksToExpiry =
        expiry +
        1 +
        ((utxo.status.confirmed && utxo.status.block_height) ||
          currentBlockHeight) -
        currentBlockHeight;
      return Math.max(maxBlocksToExpiry, blocksToExpiry);
    }, 0);
  });
};

export type SignRefundTxProps = {
  controlBlock: Buffer;
  expiry: number;
  hashType: number;
  leafHash: Buffer;
  leafScript: Buffer;
  outputScripts: Array<Buffer>;
  tx: bitcoin.Transaction;
  values: Array<number>;
};
export const signBtcRefundTx = ({
  controlBlock,
  expiry,
  hashType,
  leafHash,
  leafScript,
  outputScripts,
  signer,
  tx,
  values,
}: SignRefundTxProps & { signer: Signer }): Promise<bitcoin.Transaction> => {
  return Promise.all(
    tx.ins.map((input, i) => {
      input.sequence = expiry;
      const hash = tx.hashForWitnessV1(
        i,
        outputScripts,
        values,
        hashType,
        leafHash,
      );
      return signer.signSchnorr(hash).then((signature) => {
        tx.setWitness(i, [signature, leafScript, controlBlock]);
      });
    }),
  ).then(() => {
    return tx;
  });
};
