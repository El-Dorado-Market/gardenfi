import type {
  BitcoinProvider,
  BitcoinUTXO,
  BitcoinWallet,
} from '@catalogfi/wallets';
import type { MatchedOrder } from '@gardenfi/orderbook';
import * as bitcoin from 'bitcoinjs-lib';
import { toXOnly } from '@gardenfi/core';
import type { Result } from '@gardenfi/utils';
import {
  buildRawTx,
  generateControlBlockFor,
  generateOutputScripts,
  getLeafHash,
  htlcErrors,
  refundLeaf,
} from './btc';

export const createBtcRefundTx = ({
  internalPubkey,
  network,
  order,
  provider,
  receiver,
  signer,
}: {
  internalPubkey: Buffer;
  network: bitcoin.Network;
  order: MatchedOrder;
  provider: BitcoinProvider;
  /**
   * order.create_order.additional_data.bitcoin_optional_recipient
   */
  receiver: string;
  signer: BitcoinWallet;
}): Promise<Result<string, string>> => {
  const {
    create_order: { secret_hash: secretHash },
    source_swap: { initiator, redeemer, timelock: expiry },
  } = order;
  const initiatorPubkey = toXOnly(initiator);
  const redeemerPubkey = toXOnly(redeemer);
  return buildRawTx({
    expiry,
    initiatorPubkey,
    internalPubkey,
    network,
    provider,
    receiver,
    redeemerPubkey,
    secretHash,
  })
    .then<
      Result<
        {
          address: string;
          blocksToExpiry: number;
          internalPubkey: Buffer;
          tx: bitcoin.Transaction;
          usedUtxos: Array<BitcoinUTXO>;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { address, tx, usedUtxos },
      } = result;
      return getBlocksToExpiry({ expiry, provider, utxos: usedUtxos }).then(
        (blocksToExpiry) => {
          return {
            ok: true,
            val: {
              address,
              blocksToExpiry,
              internalPubkey,
              tx,
              usedUtxos,
            },
          };
        },
      );
    })
    .then((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { address, blocksToExpiry, internalPubkey, tx, usedUtxos },
      } = result;
      if (blocksToExpiry > 0) {
        return { error: htlcErrors.htlcNotExpired(blocksToExpiry), ok: false };
      }
      const leafScript = refundLeaf({ expiry, initiatorPubkey });
      const controlBlockResult = generateControlBlockFor({
        expiry,
        initiatorPubkey,
        internalPubkey,
        leafScript,
        network,
        redeemerPubkey,
        secretHash,
      });
      if (!controlBlockResult.ok) {
        return controlBlockResult;
      }
      const { val: controlBlock } = controlBlockResult;
      const hashType = bitcoin.Transaction.SIGHASH_DEFAULT;
      const leafHash = getLeafHash({ leafScript });
      const outputScripts = generateOutputScripts({
        address,
        count: usedUtxos.length,
        network,
      });
      const values = usedUtxos.map((utxo) => {
        return utxo.value;
      });
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
            tx.setWitness(i, [
              signature,
              refundLeaf({ expiry, initiatorPubkey }),
              controlBlock,
            ]);
          });
        }),
      ).then(() => {
        return { ok: true, val: tx.toHex() };
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
