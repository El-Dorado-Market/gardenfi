import { Environment, Url, type Result } from '@gardenfi/utils';
import { api } from './utils';
import { Orderbook, type MatchedOrder } from '@gardenfi/orderbook';
import { BlockNumberFetcher } from '@gardenfi/core';

export const fetchBlockNumbers = () => {
  return new BlockNumberFetcher(
    api.info,
    Environment.MAINNET,
  ).fetchBlockNumbers();
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

const attemptsThreshold = 20;
const intervalMs = 1000;
export const pollMatchedOrder = ({
  attempt = 0,
  orderId,
}: { attempt?: number; orderId: string }): Promise<
  Result<MatchedOrder, string>
> => {
  if (attempt >= attemptsThreshold) {
    return Promise.resolve({ error: 'Exceeded attempt threshold', ok: false });
  }
  return getMatchedOrder({ orderId }).then<Result<MatchedOrder, string>>(
    (matchedOrderResult) => {
      if (matchedOrderResult.ok) {
        return matchedOrderResult;
      }
      return new Promise<Result<MatchedOrder, string>>((resolve) => {
        setTimeout(() => {
          resolve(
            pollMatchedOrder({
              attempt: attempt + 1,
              orderId,
            }),
          );
        }, intervalMs);
      });
    },
  );
};
