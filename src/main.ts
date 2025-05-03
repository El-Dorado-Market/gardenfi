import {
  BlockNumberFetcher,
  Garden,
  type OrderWithStatus,
  ParseOrderStatus,
  Quote,
  type OrderActions,
  type SwapParams,
} from '@gardenfi/core';
import { Environment, Result } from '@gardenfi/utils';
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
  digestKey,
  wallets: {
    evm: evmWalletClient,
  },
});
// #endregion

const assignOrderStatus = ({
  blockNumbers,
  order,
}: { blockNumbers: BlockNumbers; order: MatchedOrder }): OrderWithStatus => {
  const sourceChain = order.source_swap.chain;
  const destinationChain = order.destination_swap.chain;
  const sourceChainBlockNumber = blockNumbers[sourceChain];
  const destinationChainBlockNumber = blockNumbers[destinationChain];
  const status = ParseOrderStatus(
    order,
    sourceChainBlockNumber,
    destinationChainBlockNumber,
  );
  const orderWithStatus = {
    ...order,
    status,
  };
  return orderWithStatus;
};

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

const fetchBlockNumbers = () => {
  return new BlockNumberFetcher(
    api.info,
    Environment.MAINNET,
  ).fetchBlockNumbers();
};

export const swap = (props: {
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
    .then<Result<null | MatchedOrder, string>>((result) => {
      if (result.error) {
        return new Result(false, null, result.error);
      }
      console.dir({ quote: result.val }, { depth: null });
      const firstQuote = Object.entries(result.val.quotes).at(0);
      if (!firstQuote) {
        return new Result(false, null, 'Missing quote');
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
      return props.garden.swap(swapParams) as unknown as Promise<
        Result<MatchedOrder, string>
      >;
    })
    .then<Result<null | string | { depositAddress: string }, string>>(
      (result) => {
        if (result.val === null || result.error) {
          return new Result(false, null, result.error);
        }
        const matchedOrder = result.val;
        console.dir({ swap: matchedOrder }, { depth: null });
        if (isEVM(fromAsset.chain)) {
          return evmHTLC.initiate(matchedOrder);
        }
        const withDepositAddress = {
          depositAddress: matchedOrder.source_swap.swap_id,
        };
        return new Result(true, withDepositAddress, '');
      },
    )
    .then<
      Result<
        | null
        | { orderAction: OrderActions; outboundTx: string }
        | { depositAddress: string },
        string
      >
    >((initResult) => {
      if (initResult.val === null || initResult.error) {
        return new Result(false, null, initResult.error);
      }
      const inboundTx = initResult.val;
      console.log({ inboundTx });
      return props.garden.execute().then((unsubscribe) => {
        return Promise.any([
          new Promise<Result<null, string>>((resolve) => {
            const onError = (_: MatchedOrder, error: string) => {
              unsubscribe();
              resolve(new Result(false, null, error));
            };
            props.garden.on('error', onError);
          }),
          new Promise<
            Result<{ orderAction: OrderActions; outboundTx: string }, string>
          >((resolve) => {
            const onSuccess = (
              _: MatchedOrder,
              orderAction: OrderActions,
              outboundTx: string,
            ) => {
              unsubscribe();
              resolve(new Result(true, { orderAction, outboundTx }));
            };
            props.garden.on('success', onSuccess);
          }),
        ]);
      });
    })
    .catch((error) => {
      return new Result(false, null, String(error));
    })
    .then((result) => {
      if (result.error || result.val === null) {
        console.error(result.error);
        return;
      }
      console.log(result.val);
    });
};

export const getOrder = ({
  orderId,
}: { orderId: string }): Promise<Result<null | MatchedOrder, string>> => {
  return fetch(api.orderbook + '/orders/id/' + orderId + '/matched')
    .then((res) => {
      return res.json();
    })
    .then((response) => {
      const { result: order } = response as {
        status: string;
        result?: null | MatchedOrder;
      };
      if (!order) {
        return new Result(false, null, 'Failed to get order: ' + orderId);
      }
      return new Result(true, order);
    });
};

export const getOrderWithStatus = ({
  orderId,
}: { orderId: string }): Promise<Result<null | OrderWithStatus, string>> => {
  return getOrder({ orderId })
    .then<
      Result<null | { blockNumbers: BlockNumbers; order: MatchedOrder }, string>
    >((orderResult) => {
      if (orderResult.error || orderResult.val === null) {
        return new Result(false, null, orderResult.error);
      }
      const order = orderResult.val;
      return fetchBlockNumbers().then((blockNumbersResult) => {
        if (blockNumbersResult.error) {
          return new Result(false, null, blockNumbersResult.error);
        }
        return new Result(true, {
          blockNumbers: blockNumbersResult.val,
          order,
        });
      });
    })
    .then((result) => {
      if (result.error || result.val === null) {
        return new Result(false, null, result.error);
      }
      const orderWithStatus = assignOrderStatus(result.val);

      return new Result(true, orderWithStatus);
    });
};

if (import.meta.main) {
  swap({
    amountUnit,
    fromAsset,
    garden,
    toAsset,
  });
}
