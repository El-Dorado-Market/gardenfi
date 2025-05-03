import {
  Garden,
  Quote,
  type OrderActions,
  type SwapParams,
} from '@gardenfi/core';
import { Environment, type Err, type Ok, type Result } from '@gardenfi/utils';
import {
  type Asset,
  type Chain,
  isEVM,
  type MatchedOrder,
} from '@gardenfi/orderbook';
import { api, digestKey, fromAsset, toAsset } from './utils';
import { evmHTLC, evmWalletClient } from './evm';

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
    .then<Result<MatchedOrder, string>>((result) => {
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
      return props.garden.swap(swapParams) as Promise<
        Result<MatchedOrder, string>
      >;
    })
    .then<Result<{ depositAddress: string } | string, string>>((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const matchedOrder = result.val;
      console.dir({ swap: matchedOrder }, { depth: null });
      if (isEVM(fromAsset.chain)) {
        return evmHTLC.initiate(matchedOrder);
      }
      const withDepositAddress = {
        depositAddress: matchedOrder.source_swap.swap_id,
      };
      return { ok: true, val: withDepositAddress };
    })
    .then<
      Result<
        | { depositAddress: string }
        | { orderAction: OrderActions; outboundTx: string },
        string
      >
    >((initResult) => {
      if (!initResult.ok) {
        return { error: initResult.error, ok: false };
      }
      const inboundTx = initResult.val;
      console.log({ inboundTx });
      return props.garden.execute().then((unsubscribe) => {
        return Promise.any([
          new Promise<Err<string>>((resolve) => {
            const onError = (_: MatchedOrder, error: string) => {
              unsubscribe();
              resolve({ error, ok: false });
            };
            props.garden.on('error', onError);
          }),
          new Promise<Ok<{ orderAction: OrderActions; outboundTx: string }>>(
            (resolve) => {
              const onSuccess = (
                _: MatchedOrder,
                orderAction: OrderActions,
                outboundTx: string,
              ) => {
                unsubscribe();
                resolve({ ok: true, val: { orderAction, outboundTx } });
              };
              props.garden.on('success', onSuccess);
            },
          ),
        ]);
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
