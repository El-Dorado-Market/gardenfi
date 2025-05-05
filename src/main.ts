import { Garden, OrderActions, Quote, type SwapParams } from '@gardenfi/core';
import { Environment, type Err, type Result } from '@gardenfi/utils';
import { type Asset, type Chain, isEVM } from '@gardenfi/orderbook';
import { api, digestKey, fromAsset, toAsset } from './utils';
import { evmWalletClient } from './evm';
import { swap } from './swap';
import { pollOrder, type OrderWithAction } from './orderbook';

// #region env
const amountUnit = Number.parseFloat(process.env.AMOUNT_UNIT ?? '');
if (Number.isNaN(amountUnit)) {
  throw new Error('AMOUNT_UNIT is not set');
}

const btcAddress = process.env.BTC_ADDRESS;
if (!btcAddress) {
  throw new Error('BTC_ADDRESS is not set');
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
    .then<Result<{ orderId: string; secret: string }, string>>((result) => {
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
          btcAddress,
        },
      };
      return swap({
        ...swapParams,
        evmAddress: evmWalletClient.account.address,
      });
    })
    .then<Result<{ orderWithAction: OrderWithAction; secret: string }, string>>(
      (result) => {
        if (!result.ok) {
          return { error: result.error, ok: false };
        }
        return pollOrder({
          filter: (orderWithStatus) => {
            return (
              (orderWithStatus.action === OrderActions.Initiate && {
                ok: true,
                val: orderWithStatus,
              }) || {
                error:
                  'Expected order action to be initiate, received: ' +
                  orderWithStatus.action,
                ok: false,
              }
            );
          },
          orderId: result.val.orderId,
        }).then((orderWithActionResult) => {
          if (!orderWithActionResult.ok) {
            return orderWithActionResult;
          }
          return {
            ok: true,
            val: {
              orderWithAction: orderWithActionResult.val,
              secret: result.val.secret,
            },
          };
        });
      },
    )
    .then<
      Result<
        | { depositAddress: string; orderId: string; secret: string }
        | { inboundTx: string; orderId: string; secret: string },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const {
        val: { orderWithAction, secret },
      } = result;
      console.dir({ matchedOrder: orderWithAction }, { depth: null });
      if (isEVM(fromAsset.chain) && garden.evmHTLC) {
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
                secret,
              },
            };
          });
      }
      return {
        ok: true,
        val: {
          depositAddress: orderWithAction.source_swap.swap_id,
          orderId: orderWithAction.create_order.create_id,
          secret,
        },
      };
    })
    .then<Result<{ orderWithAction: OrderWithAction; secret: string }, string>>(
      (result) => {
        if (!result.ok) {
          return { error: result.error, ok: false };
        }
        if ('inboundTx' in result.val) {
          console.log({ inboundTx: result.val.inboundTx });
        }
        return pollOrder({
          attemptsThreshold: 360,
          filter: (orderWithStatus) => {
            return (
              ((orderWithStatus.action === OrderActions.Redeem ||
                orderWithStatus.action === OrderActions.Refund) && {
                ok: true,
                val: orderWithStatus,
              }) ||
              null
            );
          },
          intervalMs: 5000,
          orderId: result.val.orderId,
        }).then((orderWithActionResult) => {
          if (!orderWithActionResult.ok) {
            return orderWithActionResult;
          }
          return {
            ok: true,
            val: {
              orderWithAction: orderWithActionResult.val,
              secret: result.val.secret,
            },
          };
        });
      },
    )
    .catch<Err<string>>(() => {
      return { error: 'Unexpected error occurred', ok: false };
    })
    .then((result) => {
      if (!result.ok) {
        console.error(result.error);
        return;
      }
      console.log(result.val);
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
