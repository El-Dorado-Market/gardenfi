import { Environment, Url, type Result } from '@gardenfi/utils';
import { api } from './utils';
import { Orderbook, type MatchedOrder } from '@gardenfi/orderbook';
import {
  BlockNumberFetcher,
  type OrderActions,
  parseActionFromStatus,
  ParseOrderStatus,
} from '@gardenfi/core';

export const fetchBlockNumbers = () => {
  return new BlockNumberFetcher(
    api.info,
    Environment.MAINNET,
  ).fetchBlockNumbers();
};

export const getOrderAction = ({
  order,
}: {
  order: MatchedOrder;
}): Promise<OrderActions> => {
  return fetchBlockNumbers().then((blockNumbers) => {
    const sourceChain = order.source_swap.chain;
    const sourceChainBlockNumber = blockNumbers.val[sourceChain];

    const destinationChain = order.destination_swap.chain;
    const destinationChainBlockNumber = blockNumbers.val[destinationChain];

    const status = ParseOrderStatus(
      order,
      sourceChainBlockNumber,
      destinationChainBlockNumber,
    );
    return parseActionFromStatus(status);
  });
};

export const getOrderWithAction = (
  order: MatchedOrder,
): Promise<Result<OrderWithAction, string>> => {
  return getOrderAction({ order }).then((action) => {
    return {
      ok: true,
      val: { ...order, action },
    };
  });
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
  intervalMs = 1000,
  orderId,
}: {
  attempt?: number;
  attemptsThreshold?: number;
  intervalMs?: number;
  orderId: string;
}): Promise<Result<OrderWithAction, string>> => {
  if (attempt >= attemptsThreshold) {
    return Promise.resolve({ error: 'Exceeded attempt threshold', ok: false });
  }
  return getMatchedOrder({ orderId: orderId })
    .then((matchedOrderResult) => {
      if (matchedOrderResult.ok) {
        return getOrderWithAction(matchedOrderResult.val);
      }
      return matchedOrderResult;
    })
    .then<Result<OrderWithAction, string>>((matchedOrderResult) => {
      if (matchedOrderResult.ok) {
        return matchedOrderResult;
      }
      return new Promise<Result<OrderWithAction, string>>((resolve) => {
        setTimeout(() => {
          resolve(
            pollOrder({
              attempt: attempt + 1,
              attemptsThreshold,
              intervalMs,
              orderId,
            }),
          );
        }, intervalMs);
      });
    });
};
