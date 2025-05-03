import { Environment, Url, type Result } from '@gardenfi/utils';
import { api } from './utils';
import { Orderbook, type MatchedOrder } from '@gardenfi/orderbook';
import {
  BlockNumberFetcher,
  ParseOrderStatus,
  type OrderWithStatus,
} from '@gardenfi/core';

export const fetchBlockNumbers = () => {
  return new BlockNumberFetcher(
    api.info,
    Environment.MAINNET,
  ).fetchBlockNumbers();
};

export const getOrder = ({
  orderId,
}: { orderId: string }): Promise<Result<MatchedOrder, string>> => {
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
        return { error: 'Failed to get order: ' + orderId, ok: false };
      }
      return { ok: true, val: order };
    });
};

export const getOrderWithStatus = ({
  orderId,
}: { orderId: string }): Promise<Result<OrderWithStatus, string>> => {
  return Promise.all([getOrder({ orderId }), fetchBlockNumbers()]).then(
    ([orderResult, blockNumbersResult]) => {
      if (!orderResult.ok) {
        return { error: orderResult.error, ok: false };
      }
      if (blockNumbersResult.error) {
        return { error: blockNumbersResult.error, ok: false };
      }
      const order = orderResult.val;
      const blockNumbers = blockNumbersResult.val;
      const sourceChain = order.source_swap.chain;
      const destinationChain = order.destination_swap.chain;
      const sourceChainBlockNumber = blockNumbers[sourceChain];
      const destinationChainBlockNumber = blockNumbers[destinationChain];
      const status = ParseOrderStatus(
        order,
        sourceChainBlockNumber,
        destinationChainBlockNumber,
      );

      return { ok: true, val: { ...order, status } };
    },
  );
};

export const orderbook = new Orderbook(new Url(api.orderbook));
