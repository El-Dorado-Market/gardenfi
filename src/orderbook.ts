import { Environment, Url, type Result } from '@gardenfi/utils';
import { api } from './utils';
import { Orderbook, type Chain, type MatchedOrder } from '@gardenfi/orderbook';
import {
  BlockNumberFetcher,
  type OrderActions,
  parseActionFromStatus,
  ParseOrderStatus,
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
}): OrderActions => {
  const sourceChain = order.source_swap.chain;
  const sourceChainBlockNumber = blockNumbers[sourceChain];

  const destinationChain = order.destination_swap.chain;
  const destinationChainBlockNumber = blockNumbers[destinationChain];

  const status = ParseOrderStatus(
    order,
    sourceChainBlockNumber,
    destinationChainBlockNumber,
  );
  return parseActionFromStatus(status);
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

export type OrderWithAction = MatchedOrder & { action: OrderActions };

export const pollOrder = ({
  attempt = 0,
  attemptsThreshold = 10,
  filter,
  intervalMs = 1000,
  orderId,
}: {
  attempt?: number;
  attemptsThreshold?: number;
  filter: (order: OrderWithAction) => null | Result<OrderWithAction, string>;
  intervalMs?: number;
  orderId: string;
}): Promise<Result<OrderWithAction, string>> => {
  if (attempt >= attemptsThreshold) {
    return Promise.resolve({ error: 'Exceeded attempt threshold', ok: false });
  }
  return Promise.all([
    getMatchedOrder({ orderId: orderId }),
    fetchBlockNumbers(),
  ]).then<Result<OrderWithAction, string>>(
    ([orderWithStatusResult, blockNumbersResult]) => {
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
      return new Promise<Result<OrderWithAction, string>>((resolve) => {
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
    },
  );
};
