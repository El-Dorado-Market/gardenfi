import * as ecc from 'tiny-secp256k1';
import type * as bitcoin from 'bitcoinjs-lib';
import {
  Garden,
  OrderActions,
  Quote,
  toXOnly,
  type QuoteResponse,
  type SwapParams,
} from '@gardenfi/core';
import {
  checkAllowanceAndApprove,
  Environment,
  Err,
  type Result,
} from '@gardenfi/utils';
import { isBitcoin, type Asset, type Chain } from '@gardenfi/orderbook';
import { api, digestKey, fromAsset, mnemonic, toAsset } from './utils';
import { createEvmInitiateTx, createEvmRedeemTx, evmWalletClient } from './evm';
import { swap } from './swap';
import { pollOrder, type OrderWithAction } from './orderbook';
import { btcProvider, getHdKey } from './btc';
import { createBtcRefundTx, signBtcRefundTx } from './btcRefund';
import { createBtcRedeemTx, signBtcRedeemTx } from './btcRedeem';

// #region env
const amountUnit = Number.parseFloat(process.env.AMOUNT_UNIT ?? '');
if (Number.isNaN(amountUnit)) {
  throw new Error('AMOUNT_UNIT is not set');
}

const btcRecipientAddress = process.env.BTC_RECIPIENT_ADDRESS;
if (!btcRecipientAddress) {
  throw new Error('BTC_RECIPIENT_ADDRESS is not set');
}
// #endregion

// #region garden
export const garden = Garden.fromWallets({
  environment: Environment.MAINNET,
  digestKey: digestKey.digestKey,
  wallets: {
    evm: evmWalletClient,
  },
});
// #endregion

export type BlockNumbers = {
  [key in Chain]: number;
};

const constructOrderPair = (props: { fromAsset: Asset; toAsset: Asset }) => {
  return (
    props.fromAsset.chain +
    ':' +
    props.fromAsset.atomicSwapAddress +
    '::' +
    props.toAsset.chain +
    ':' +
    props.toAsset.atomicSwapAddress
  );
};

export const fetchQuote = (props: {
  amountUnit: number;
  fromAsset: Asset;
  garden: Garden;
  toAsset: Asset;
}) => {
  const sendAmount = props.amountUnit * 10 ** props.fromAsset.decimals;
  const orderPair = constructOrderPair({
    fromAsset: props.fromAsset,
    toAsset: props.toAsset,
  });
  console.dir(
    {
      quoteProps: {
        orderPair,
        sendAmount,
      },
    },
    { depth: null },
  );
  return Promise.all([
    getHdKey({ mnemonic }),
    new Quote(api.quote).getQuote(orderPair, sendAmount, false),
  ])
    .then<
      Result<
        { btcPrivateKey: Buffer; btcPublicKey: string; quote: QuoteResponse },
        string
      >
    >(([hdKey, quoteResult]) => {
      if (!hdKey.privateKey) {
        return { error: 'Failed to derive private key', ok: false };
      }
      if (!hdKey.publicKey) {
        return { error: 'Failed to derive public key', ok: false };
      }
      const publicKey = Buffer.from(hdKey.publicKey).toString('hex');
      console.log({ publicKey });
      if (quoteResult.error) {
        return Err(quoteResult.error);
      }
      const { val: quote } = quoteResult;
      return {
        ok: true,
        val: {
          btcPrivateKey: Buffer.from(hdKey.privateKey),
          btcPublicKey: toXOnly(publicKey),
          quote,
        },
      };
    })
    .then<
      Result<
        {
          btcPrivateKey: Buffer;
          orderId: string;
          secret: string;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { btcPrivateKey, btcPublicKey, quote },
      } = result;
      console.dir({ quote }, { depth: null });
      const firstQuote = Object.entries(quote.quotes).at(0);
      if (!firstQuote) {
        return { error: 'Missing quote', ok: false };
      }
      const [strategyId, quoteAmount] = firstQuote;
      const swapParams: SwapParams = {
        fromAsset: props.fromAsset,
        toAsset: props.toAsset,
        sendAmount: sendAmount.toString(),
        receiveAmount: quoteAmount,
        additionalData: {
          strategyId,
          btcAddress: btcRecipientAddress,
        },
      };
      return swap({
        ...swapParams,
        btcPublicKey,
        btcRecipientAddress,
        evmAddress: evmWalletClient.account.address,
      }).then((swapResult) => {
        if (!swapResult.ok) {
          return swapResult;
        }
        const {
          val: { orderId, secret },
        } = swapResult;
        return {
          ok: true,
          val: {
            btcPrivateKey,
            orderId,
            secret,
          },
        };
      });
    })
    .then<
      Result<
        {
          btcPrivateKey: Buffer;
          orderWithAction: OrderWithAction;
          secret: string;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const {
        val: { btcPrivateKey, orderId, secret },
      } = result;
      console.log({ secret });
      return pollOrder({
        filter: ({ action, ...order }) => {
          return (
            (action === OrderActions.Initiate && {
              ok: true,
              val: { ...order, action },
            }) || {
              error:
                'Expected order action to be initiate, received: ' + action,
              ok: false,
            }
          );
        },
        orderId,
      }).then((orderWithActionResult) => {
        if (!orderWithActionResult.ok) {
          return orderWithActionResult;
        }
        const { val: orderWithAction } = orderWithActionResult;
        return {
          ok: true,
          val: {
            btcPrivateKey,
            orderWithAction,
            secret,
          },
        };
      });
    })
    .then<
      Result<
        {
          btcPrivateKey: Buffer;
          orderWithAction: OrderWithAction;
          secret: string;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const {
        val: { btcPrivateKey, orderWithAction, secret },
      } = result;
      console.dir({ orderWithAction }, { depth: null });
      if (isBitcoin(fromAsset.chain)) {
        return {
          ok: true,
          val: {
            btcPrivateKey,
            orderWithAction,
            secret,
          },
        };
      }
      return checkAllowanceAndApprove(
        Number(orderWithAction.source_swap.amount),
        fromAsset.tokenAddress,
        orderWithAction.source_swap.asset,
        evmWalletClient,
      ).then((allowanceTxResult) => {
        if (allowanceTxResult.error) {
          return Err(allowanceTxResult.error);
        }
        const { val: allowanceTx } = allowanceTxResult;
        console.log({ allowanceTx });
        return {
          ok: true,
          val: {
            btcPrivateKey,
            orderWithAction,
            secret,
          },
        };
      });
    })
    .then<
      Result<
        | {
            btcPrivateKey: Buffer;
            orderId: string;
            secret: string;
          }
        | {
            btcPrivateKey: Buffer;
            inboundTx: string;
            orderId: string;
            secret: string;
          },
        string
      >
    >((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: {
          btcPrivateKey,
          orderWithAction: {
            create_order: { create_id: orderId },
            source_swap: {
              amount: amountSubunit,
              asset: atomicSwapAddress,
              redeemer,
              secret_hash: secretHash,
              timelock,
            },
          },
          secret,
        },
      } = result;
      if (isBitcoin(fromAsset.chain)) {
        return {
          ok: true,
          val: {
            btcPrivateKey,
            orderId,
            secret,
          },
        };
      }
      const initiateTx = createEvmInitiateTx({
        amountSubunit,
        atomicSwapAddress,
        redeemer,
        secretHash,
        timelock,
      });
      return evmWalletClient.sendTransaction(initiateTx).then((inboundTx) => {
        console.log({ inboundTx });
        return {
          ok: true,
          val: {
            btcPrivateKey,
            inboundTx,
            orderId,
            secret,
          },
        };
      });
    })
    .then<
      Result<
        {
          btcPrivateKey: Buffer;
          orderWithAction: OrderWithAction;
          secret: string;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const {
        val: { btcPrivateKey, orderId, secret },
      } = result;
      return pollOrder({
        attemptsThreshold: 720,
        filter: ({ action, ...order }) => {
          return (
            ((action === OrderActions.Redeem ||
              action === OrderActions.Refund) && {
              ok: true,
              val: { ...order, action },
            }) ||
            null
          );
        },
        intervalMs: 5000,
        orderId,
      }).then((orderWithActionResult) => {
        if (!orderWithActionResult.ok) {
          return orderWithActionResult;
        }
        return {
          ok: true,
          val: {
            btcPrivateKey,
            orderWithAction: orderWithActionResult.val,
            secret,
          },
        };
      });
    })
    .then<Result<string, string>>((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { btcPrivateKey, orderWithAction, secret },
      } = result;
      if (orderWithAction.action === OrderActions.Refund) {
        if (isBitcoin(orderWithAction.source_swap.chain)) {
          return createBtcRefundTx({
            expiry: orderWithAction.source_swap.timelock,
            initiatorAddress: orderWithAction.source_swap.initiator,
            receiver: btcRecipientAddress,
            redeemerAddress: orderWithAction.source_swap.redeemer,
            secretHash: orderWithAction.source_swap.secret_hash,
            sign: (hash) => {
              return Buffer.from(ecc.signSchnorr(hash, btcPrivateKey));
            },
          })
            .then<Result<bitcoin.Transaction, string>>((result) => {
              if (!result.ok) {
                return result;
              }
              const { val: signRefundTxProps } = result;
              const tx = signBtcRefundTx(signRefundTxProps);
              return {
                ok: true,
                val: tx,
              };
            })
            .then((result) => {
              if (!result.ok) {
                return result;
              }
              const { val: tx } = result;
              return btcProvider.broadcast(tx.toHex()).then((outboundTx) => {
                return {
                  ok: true,
                  val: outboundTx,
                };
              });
            });
        }
        return { ok: true, val: 'EVM refunds are handled automatically' };
      }
      if (isBitcoin(orderWithAction.destination_swap.chain)) {
        return createBtcRedeemTx({
          expiry: orderWithAction.destination_swap.timelock,
          initiatorAddress: orderWithAction.destination_swap.initiator,
          receiver: btcRecipientAddress,
          redeemerAddress: orderWithAction.destination_swap.redeemer,
          secret,
          secretHash: orderWithAction.destination_swap.secret_hash,
          sign: (hash) => {
            return Buffer.from(ecc.signSchnorr(hash, btcPrivateKey));
          },
        })
          .then<Result<bitcoin.Transaction, string>>((result) => {
            if (!result.ok) {
              return result;
            }
            const { val: signRedeemTxProps } = result;
            const tx = signBtcRedeemTx(signRedeemTxProps);
            return {
              ok: true,
              val: tx,
            };
          })
          .then((result) => {
            if (!result.ok) {
              return result;
            }
            const { val: redeemTx } = result;
            return btcProvider
              .broadcast(redeemTx.toHex())
              .then((outboundTx) => {
                return {
                  ok: true,
                  val: outboundTx,
                };
              });
          });
      }
      const redeemTx = createEvmRedeemTx({
        contractAddress: orderWithAction.destination_swap.asset,
        swapId: orderWithAction.destination_swap.swap_id,
        secret,
      });
      return evmWalletClient.sendTransaction(redeemTx).then((outboundTx) => {
        return { ok: true, val: outboundTx };
      });
    })
    .then((result) => {
      if (!result.ok) {
        console.error({ error: result.error });
        return;
      }
      const { val: outboundTx } = result;
      console.log({ outboundTx });
    })
    .catch((error) => {
      console.dir({ error }, { depth: null });
    });
};

if (import.meta.main) {
  fetchQuote({
    amountUnit,
    fromAsset,
    garden,
    toAsset,
  });
}
