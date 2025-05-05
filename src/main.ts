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
    .then<Result<string, string>>((result) => {
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
    .then<Result<OrderWithAction, string>>((orderIdResult) => {
      if (!orderIdResult.ok) {
        return { error: orderIdResult.error, ok: false };
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
        orderId: orderIdResult.val,
      });
    })
    .then<
      Result<
        | { depositAddress: string; orderId: string }
        | { inboundTx: string; orderId: string },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const matchedOrder = result.val;
      console.dir({ matchedOrder }, { depth: null });
      if (isEVM(fromAsset.chain) && garden.evmHTLC) {
        return garden.evmHTLC
          .initiate(matchedOrder)
          .then<Result<{ inboundTx: string; orderId: string }, string>>(
            (inboundTxResult) => {
              if (!inboundTxResult.ok) {
                return inboundTxResult;
              }
              return {
                ok: true,
                val: {
                  inboundTx: inboundTxResult.val,
                  orderId: matchedOrder.create_order.create_id,
                },
              };
            },
          );
      }
      return {
        ok: true,
        val: {
          depositAddress: matchedOrder.source_swap.swap_id,
          orderId: matchedOrder.create_order.create_id,
        },
      };
    })
    .then<Result<OrderWithAction, string>>((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      if ('inboundTx' in result.val) {
        console.log({ inboundTx: result.val.inboundTx });
      }
      return pollOrder({
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
        orderId: result.val.orderId,
      });
    })
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
