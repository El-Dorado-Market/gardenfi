import { trim0x } from '@catalogfi/utils';
import { Quote, type SwapParams } from '@gardenfi/core';
import {
  type AdditionalDataWithStrategyId,
  Chains,
  type CreateOrderRequestWithAdditionalData,
  type CreateOrderReqWithStrategyId,
  getTimeLock,
  isBitcoin,
  isMainnet,
} from '@gardenfi/orderbook';
import BigNumber from 'bignumber.js';
import { generateSecret } from './secretManager';
import { api, digestKey } from './utils';
import { Err, type Result } from '@gardenfi/utils';
import { auth } from './auth';
import { getBtcAddress } from './btc';
import { orderbook } from './orderbook';
import {
  createEvmRedeemTx,
  createEvmRefundTx,
  type EvmTransaction,
} from './evm';
import { createBtcRedeemTx } from './btcRedeem';
import { createBtcRefundTx } from './btcRefund';

export type SwapProps = SwapParams & {
  btcRecipientAddress: string;
  evmAddress: string;
};
export type Tx = EvmTransaction | string;
export const swap = (
  props: SwapProps,
): Promise<
  Result<
    {
      orderId: string;
      redeemTx: Tx;
      refundTx: Tx;
    },
    string
  >
> => {
  const validatedProps = validateProps(props);
  if (!validatedProps.ok) {
    return Promise.resolve({ error: validatedProps.error, ok: false });
  }
  const {
    val: {
      additionalData: { strategyId },
      btcRecipientAddress,
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
    .then<
      Result<
        {
          attestedQuote: CreateOrderRequestWithAdditionalData;
          redeemTx: Tx;
          refundTx: Tx;
        },
        string
      >
    >((btcAddressResult) => {
      if (!btcAddressResult.ok) {
        return { error: btcAddressResult.error, ok: false };
      }
      const { val: btcAddress } = btcAddressResult;
      const expiry = getTimeLock(Chains.bitcoin);
      const nonce = Date.now().toString();
      const secretResult = generateSecret({
        digestKey: digestKey.digestKey,
        nonce,
      });
      if (!secretResult.ok) {
        return { error: secretResult.error, ok: false };
      }
      const {
        val: { secret, secretHash },
      } = secretResult;
      const additionalData: AdditionalDataWithStrategyId['additional_data'] = {
        strategy_id: strategyId,
        ...(btcRecipientAddress && {
          bitcoin_optional_recipient: btcRecipientAddress,
        }),
      };
      const receiveAddress =
        (isBitcoin(toAsset.chain) && btcAddress) || evmAddress;
      const sendAddress =
        (isBitcoin(fromAsset.chain) && btcAddress) || evmAddress;
      const order: CreateOrderReqWithStrategyId = {
        additional_data: additionalData,
        destination_amount: receiveAmount,
        destination_asset: toAsset.atomicSwapAddress,
        destination_chain: toAsset.chain,
        fee: '1',
        initiator_destination_address: receiveAddress,
        initiator_source_address: sendAddress,
        min_destination_confirmations: minDestinationConfirmations ?? 0,
        nonce,
        secret_hash: trim0x(secretHash),
        source_amount: sendAmount,
        source_asset: fromAsset.atomicSwapAddress,
        source_chain: fromAsset.chain,
        timelock,
      };
      const txPromises: [
        Promise<Result<Tx, string>>,
        Promise<Result<Tx, string>>,
      ] = [
        (isBitcoin(toAsset.chain) &&
          createBtcRedeemTx({
            expiry,
            initiatorAddress: order.initiator_destination_address,
            receiver: btcRecipientAddress,
            redeemerAddress: btcAddress,
            secret,
            secretHash,
          })) ||
          Promise.resolve({
            ok: true,
            val: createEvmRedeemTx({
              contractAddress: order.destination_asset,
              initiatorAddress: order.initiator_destination_address,
              secret,
              secretHash,
            }),
          }),
        (isBitcoin(fromAsset.chain) &&
          createBtcRefundTx({
            expiry,
            initiatorAddress: order.initiator_source_address,
            receiver: btcRecipientAddress,
            redeemerAddress: btcAddress,
            secretHash,
          })) ||
          Promise.resolve({
            ok: true,
            val: createEvmRefundTx({
              contractAddress: order.source_asset,
              initiatorAddress: order.initiator_source_address,
              secretHash,
            }),
          }),
      ];
      return Promise.all([
        new Quote(api.quote).getAttestedQuote(order),
        ...txPromises,
      ]).then(([attestedQuoteResult, redeemTxResult, refundTxResult]) => {
        if (attestedQuoteResult.error) {
          return Err(attestedQuoteResult.error);
        }
        const { val: attestedQuote } = attestedQuoteResult;
        if (!redeemTxResult.ok) {
          return redeemTxResult;
        }
        const { val: redeemTx } = redeemTxResult;
        if (!refundTxResult.ok) {
          return refundTxResult;
        }
        const { val: refundTx } = refundTxResult;
        return {
          ok: true,
          val: {
            attestedQuote,
            redeemTx,
            refundTx,
          },
        };
      });
    })
    .then<
      Result<
        {
          orderId: string;
          redeemTx: Tx;
          refundTx: Tx;
        },
        string
      >
    >((result) => {
      if (!result.ok) {
        return { error: result.error, ok: false };
      }
      const {
        val: { attestedQuote, redeemTx, refundTx },
      } = result;
      return orderbook
        .createOrder(attestedQuote, auth)
        .then((orderIdResult) => {
          if (orderIdResult.error) {
            return Err(orderIdResult.error);
          }
          const { val: orderId } = orderIdResult;
          return {
            ok: true,
            val: {
              orderId,
              redeemTx,
              refundTx,
            },
          };
        });
    })
    .then((result) => {
      if (!result.ok) {
        return result;
      }
      const {
        val: { orderId, redeemTx, refundTx },
      } = result;
      return {
        ok: true,
        val: {
          orderId,
          redeemTx,
          refundTx,
        },
      };
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
