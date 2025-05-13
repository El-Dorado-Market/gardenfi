import { Environment, Url, type Result } from '@gardenfi/utils';
import { api } from './utils';
import { Orderbook, type Chain, type MatchedOrder } from '@gardenfi/orderbook';
import {
  BlockNumberFetcher,
  OrderActions,
  ParseSwapStatus,
  SwapStatus,
} from '@gardenfi/core';

export type BlockNumbers = {
  [key in Chain]: number;
};
export const fetchBlockNumbers = () => {
  return new BlockNumberFetcher(
    api.info,
    Environment.MAINNET,
  ).fetchBlockNumbers();
};

export const getOrderAction = ({
  blockNumbers,
  order,
}: {
  blockNumbers: BlockNumbers;
  order: MatchedOrder;
}):
  | null
  | OrderActions.Initiate
  | OrderActions.Refund
  | OrderActions.Redeem => {
  const destinationChain = order.destination_swap.chain;
  const destinationChainBlockNumber = blockNumbers[destinationChain];
  const destinationStatus = ParseSwapStatus(
    order.destination_swap,
    destinationChainBlockNumber,
  );

  const sourceChain = order.source_swap.chain;
  const sourceChainBlockNumber = blockNumbers[sourceChain];
  const sourceStatus = ParseSwapStatus(
    order.source_swap,
    sourceChainBlockNumber,
  );

  return (
    (sourceStatus === SwapStatus.Idle && OrderActions.Initiate) ||
    (sourceStatus === SwapStatus.Expired && OrderActions.Refund) ||
    (destinationStatus === SwapStatus.Initiated && OrderActions.Redeem) ||
    null
  );
};

export const getOrderWithAction = ({
  blockNumbers,
  order,
}: { blockNumbers: BlockNumbers; order: MatchedOrder }): OrderWithAction => {
  const action = getOrderAction({ blockNumbers, order });
  return { ...order, action };
};

export const getMatchedOrder = ({
  orderId,
}: { orderId: string }): Promise<Result<MatchedOrder, string>> => {
  return fetch(api.orderbook + '/orders/id/' + orderId + '/matched')
    .then((res) => {
      return res.json();
    })
    .then((response) => {
      const { result: order } = response as {
        status: string;
        result: null | MatchedOrder;
      };
      if (!order) {
        return { error: 'Failed to get order: ' + orderId, ok: false };
      }
      return { ok: true, val: order };
    });
};

export const orderbook = new Orderbook(new Url(api.orderbook));

export type OrderWithAction<
  A extends OrderActions | null = OrderActions | null,
> = MatchedOrder & { action: A };

export const pollOrder = <A extends OrderActions>({
  attempt = 0,
  attemptsThreshold = 10,
  filter,
  intervalMs = 1000,
  orderId,
}: {
  attempt?: number;
  attemptsThreshold?: number;
  filter: (order: OrderWithAction) => null | Result<OrderWithAction<A>, string>;
  intervalMs?: number;
  orderId: string;
}): Promise<Result<OrderWithAction<A>, string>> => {
  if (attempt >= attemptsThreshold) {
    return Promise.resolve({ error: 'Exceeded attempt threshold', ok: false });
  }
  return Promise.all([
    getMatchedOrder({ orderId: orderId }),
    fetchBlockNumbers(),
  ]).then(([orderWithStatusResult, blockNumbersResult]) => {
    const filteredOrderResult =
      orderWithStatusResult.ok &&
      blockNumbersResult.val &&
      filter(
        getOrderWithAction({
          blockNumbers: blockNumbersResult.val,
          order: orderWithStatusResult.val,
        }),
      );
    if (filteredOrderResult) {
      return filteredOrderResult;
    }
    return new Promise<Result<OrderWithAction<A>, string>>((resolve) => {
      setTimeout(() => {
        resolve(
          pollOrder({
            attempt: attempt + 1,
            attemptsThreshold,
            filter: filter,
            intervalMs,
            orderId,
          }),
        );
      }, intervalMs);
    });
  });
};
