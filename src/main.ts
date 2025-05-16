import type * as bitcoin from 'bitcoinjs-lib';
import { Garden, OrderActions, Quote, type SwapParams } from '@gardenfi/core';
import {
  checkAllowanceAndApprove,
  Environment,
  Err,
  type Result,
} from '@gardenfi/utils';
import { isBitcoin, type Asset, type Chain } from '@gardenfi/orderbook';
import { api, digestKey, fromAsset, toAsset } from './utils';
import { createEvmInitiateTx, createEvmRedeemTx, evmWalletClient } from './evm';
import { swap } from './swap';
import { pollOrder, type OrderWithAction } from './orderbook';
import { btcProvider, btcWallet } from './btc';
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
  return new Quote(api.quote)
    .getQuote(orderPair, sendAmount, false)
    .then<
      Result<
        {
          orderId: string;
          secret: string;
        },
        string
      >
    >((result) => {
      if (result.error) {
        return { error: result.error, ok: false };
      }
      console.dir({ quote: result.val }, { depth: null });
      const firstQuote = Object.entries(result.val.quotes).at(0);
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
        btcRecipientAddress,
        evmAddress: evmWalletClient.account.address,
      });
    })
    .then<
      Result<
        {
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
        val: { orderId, secret },
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
            orderWithAction,
            secret,
          },
        };
      });
    })
    .then<
      Result<
        {
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
        val: { orderWithAction, secret },
      } = result;
      console.dir({ orderWithAction }, { depth: null });
      if (isBitcoin(fromAsset.chain)) {
        return {
          ok: true,
          val: {
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
            orderWithAction,
            secret,
          },
        };
      });
    })
    .then<
      Result<
        | { orderId: string; secret: string }
        | { inboundTx: string; orderId: string; secret: string },
        string
      >
    >((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: {
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
          val: { inboundTx, orderId, secret },
        };
      });
    })
    .then<
      Result<
        {
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
        val: { orderId, secret },
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
        val: { orderWithAction, secret },
      } = result;
      if (orderWithAction.action === OrderActions.Refund) {
        if (isBitcoin(orderWithAction.source_swap.chain)) {
          return createBtcRefundTx({
            expiry: orderWithAction.source_swap.timelock,
            initiatorAddress: orderWithAction.source_swap.initiator,
            receiver: btcRecipientAddress,
            redeemerAddress: orderWithAction.source_swap.redeemer,
            secretHash: orderWithAction.source_swap.secret_hash,
          })
            .then<Result<bitcoin.Transaction, string>>((result) => {
              if (!result.ok) {
                return result;
              }
              const { val: signRefundTxProps } = result;
              const signer = btcWallet; // TODO replace with user's wallet
              return signBtcRefundTx({ ...signRefundTxProps, signer }).then(
                (tx) => {
                  return {
                    ok: true,
                    val: tx,
                  };
                },
              );
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
        })
          .then<Result<bitcoin.Transaction, string>>((result) => {
            if (!result.ok) {
              return result;
            }
            const { val: signRedeemTxProps } = result;
            const signer = btcWallet; // TODO replace with user's wallet
            return signBtcRedeemTx({ ...signRedeemTxProps, signer }).then(
              (tx) => {
                return {
                  ok: true,
                  val: tx,
                };
              },
            );
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
