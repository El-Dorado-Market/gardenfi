import { trim0x } from '@catalogfi/utils';
import { Quote, type SwapParams } from '@gardenfi/core';
import {
  type AdditionalDataWithStrategyId,
  type CreateOrderRequestWithAdditionalData,
  type CreateOrderReqWithStrategyId,
  getTimeLock,
  isBitcoin,
  isMainnet,
} from '@gardenfi/orderbook';
import BigNumber from 'bignumber.js';
import { generateSecret } from './secretManager';
import { api, digestKey } from './utils';
import type { Result } from '@gardenfi/utils';
import { auth } from './auth';
import { getBtcAddress } from './btc';
import { orderbook } from './orderbook';

export type SwapProps = SwapParams & { evmAddress: string };
export const swap = (props: SwapProps): Promise<Result<string, string>> => {
  const validatedProps = validateProps(props);
  if (!validatedProps.ok) {
    return Promise.resolve({ error: validatedProps.error, ok: false });
  }
  const {
    val: {
      additionalData: { strategyId, btcAddress: bitcoinOptionalRecipient },
      fromAsset,
      evmAddress,
      minDestinationConfirmations,
      receiveAmount,
      sendAmount,
      timelock,
      toAsset,
    },
  } = validatedProps;
  return getBtcAddress()
    .then<Result<CreateOrderRequestWithAdditionalData, string>>(
      (btcAddressResult) => {
        if (!btcAddressResult.ok) {
          return { error: btcAddressResult.error, ok: false };
        }
        const nonce = Date.now().toString();
        const secretResult = generateSecret({
          digestKey: digestKey.digestKey,
          nonce,
        });
        if (!secretResult.ok) {
          return { error: secretResult.error, ok: false };
        }
        const additionalData: AdditionalDataWithStrategyId['additional_data'] =
          {
            strategy_id: strategyId,
            ...(bitcoinOptionalRecipient && {
              bitcoin_optional_recipient: bitcoinOptionalRecipient,
            }),
          };
        const receiveAddress =
          (isBitcoin(toAsset.chain) && btcAddressResult.val) || evmAddress;
        const sendAddress =
          (isBitcoin(fromAsset.chain) && btcAddressResult.val) || evmAddress;
        const order: CreateOrderReqWithStrategyId = {
          additional_data: additionalData,
          destination_amount: receiveAmount,
          destination_asset: toAsset.atomicSwapAddress,
          destination_chain: toAsset.chain,
          fee: '1',
          initiator_destination_address: receiveAddress,
          initiator_source_address: sendAddress,
          min_destination_confirmations: minDestinationConfirmations ?? 0,
          nonce: nonce,
          secret_hash: trim0x(secretResult.val.secretHash),
          source_amount: sendAmount,
          source_asset: fromAsset.atomicSwapAddress,
          source_chain: fromAsset.chain,
          timelock,
        };
        return new Quote(api.quote).getAttestedQuote(order) as Promise<
          Result<CreateOrderRequestWithAdditionalData, string>
        >;
      },
    )
    .then<Result<string, string>>((attestedQuoteResult) => {
      if (!attestedQuoteResult.ok) {
        return { error: attestedQuoteResult.error, ok: false };
      }
      return orderbook.createOrder(attestedQuoteResult.val, auth) as Promise<
        Result<string, string>
      >;
    });
};

export const validateProps = (
  props: SwapProps,
): Result<Omit<SwapProps, 'timelock'> & { timelock: number }, string> => {
  if (!props.additionalData.strategyId) {
    return { error: 'StrategyId is required', ok: false };
  }

  if (
    props.fromAsset.chain === props.toAsset.chain &&
    props.fromAsset.atomicSwapAddress === props.toAsset.atomicSwapAddress
  ) {
    return {
      error: 'Source and destination assets cannot be the same',
      ok: false,
    };
  }

  if (
    (isMainnet(props.fromAsset.chain) && !isMainnet(props.toAsset.chain)) ||
    (!isMainnet(props.fromAsset.chain) && isMainnet(props.toAsset.chain))
  ) {
    return {
      error:
        'Both assets should be on the same network (either mainnet or testnet)',
      ok: false,
    };
  }

  const inputAmount = validateAmount(props.sendAmount);
  if (inputAmount.error) {
    return { error: inputAmount.error, ok: false };
  }

  const outputAmount = validateAmount(props.receiveAmount);
  if (outputAmount.error) {
    return { error: outputAmount.error, ok: false };
  }

  if (inputAmount < outputAmount) {
    return {
      error: 'Send amount should be greater than receive amount',
      ok: false,
    };
  }

  const timelock = getTimeLock(props.fromAsset.chain);
  if (!timelock) {
    return { error: 'Unsupported chain for timelock', ok: false };
  }

  if (
    (isBitcoin(props.fromAsset.chain) || isBitcoin(props.toAsset.chain)) &&
    !props.additionalData.btcAddress
  ) {
    return {
      error:
        'btcAddress in additionalData is required if source or destination chain is bitcoin, it is used as refund or redeem address.',
      ok: false,
    };
  }

  return { ok: true, val: { ...props, timelock: props.timelock ?? timelock } };
};

export const validateAmount = (amount: string): Result<BigNumber, string> => {
  const amountBigInt = new BigNumber(amount);
  if (
    !amountBigInt.isInteger() ||
    amountBigInt.isNaN() ||
    amountBigInt.isLessThanOrEqualTo(0)
  ) {
    return { error: 'Invalid amount ' + amount, ok: false };
  }
  return { ok: true, val: amountBigInt };
};
