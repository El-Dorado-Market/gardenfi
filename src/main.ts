import { Garden, OrderActions, Quote, type SwapParams } from '@gardenfi/core';
import { Environment, with0x, type Result } from '@gardenfi/utils';
import type { Asset, Chain } from '@gardenfi/orderbook';
import { api, digestKey, fromAsset, toAsset } from './utils';
import { evmWalletClient } from './evm';
import { swap, type Tx } from './swap';
import { pollOrder, type OrderWithAction } from './orderbook';
import { btcProvider } from './btc';

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
          redeemTx: Tx;
          refundTx: Tx;
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
          redeemTx: Tx;
          refundTx: Tx;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const {
        val: { orderId, redeemTx, refundTx },
      } = result;
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
        return {
          ok: true,
          val: {
            orderWithAction: orderWithActionResult.val,
            redeemTx,
            refundTx,
          },
        };
      });
    })
    .then<
      Result<
        | {
            depositAddress: string;
            orderId: string;
            redeemTx: Tx;
            refundTx: Tx;
          }
        | {
            inboundTx: string;
            orderId: string;
            redeemTx: Tx;
            refundTx: Tx;
          },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const {
        val: { orderWithAction, redeemTx, refundTx },
      } = result;
      console.dir({ matchedOrder: orderWithAction }, { depth: null });
      if (typeof redeemTx === 'object' && garden.evmHTLC) {
        return garden.evmHTLC
          .initiate(orderWithAction)
          .then((inboundTxResult) => {
            if (!inboundTxResult.ok) {
              return inboundTxResult;
            }
            return {
              ok: true,
              val: {
                inboundTx: inboundTxResult.val,
                orderId: orderWithAction.create_order.create_id,
                redeemTx,
                refundTx,
              },
            };
          });
      }
      return {
        ok: true,
        val: {
          depositAddress: orderWithAction.source_swap.swap_id,
          orderId: orderWithAction.create_order.create_id,
          redeemTx,
          refundTx,
        },
      };
    })
    .then<
      Result<
        {
          orderWithAction: OrderWithAction;
          redeemTx: Tx;
          refundTx: Tx;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      if ('inboundTx' in result.val) {
        console.log({ inboundTx: result.val.inboundTx });
      }
      const {
        val: { orderId, redeemTx, refundTx },
      } = result;
      return pollOrder({
        attemptsThreshold: 360,
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
            redeemTx,
            refundTx,
          },
        };
      });
    })
    .then<Result<string, string>>((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { orderWithAction, redeemTx, refundTx },
      } = result;
      if (orderWithAction.action === OrderActions.Refund) {
        if (typeof refundTx === 'object') {
          return evmWalletClient
            .sendTransaction({
              data: with0x(refundTx.data),
              to: with0x(refundTx.to),
            })
            .then((outboundTx) => {
              return { ok: true, val: outboundTx };
            });
        }
        return btcProvider.broadcast(refundTx).then((outboundTx) => {
          return {
            ok: true,
            val: outboundTx,
          };
        });
      }
      if (typeof redeemTx === 'object') {
        return evmWalletClient
          .sendTransaction({
            data: with0x(redeemTx.data),
            to: with0x(redeemTx.to),
          })
          .then((outboundTx) => {
            return { ok: true, val: outboundTx };
          });
      }
      return btcProvider.broadcast(redeemTx).then((outboundTx) => {
        return {
          ok: true,
          val: outboundTx,
        };
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
