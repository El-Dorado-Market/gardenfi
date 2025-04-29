import { createWalletClient, http } from 'viem';
import type { Chain } from 'viem/chains';
import {
  evmToViemChainMap,
  Garden,
  type OrderActions,
  type SwapParams,
} from '@gardenfi/core';
import { Environment, DigestKey, Result } from '@gardenfi/utils';
import { mnemonicToAccount } from 'viem/accounts';
import {
  type Asset,
  isEVM,
  type MatchedOrder,
  SupportedAssets,
} from '@gardenfi/orderbook';

// #region env
const amountUnit = Number.parseFloat(process.env.AMOUNT_UNIT ?? '');
if (Number.isNaN(amountUnit)) {
  throw new Error('AMOUNT_UNIT is not set');
}

const btcAddress = process.env.BTC_ADDRESS;
if (!btcAddress) {
  throw new Error('BTC_ADDRESS is not set');
}

const gardenApiUrl = process.env.GARDEN_API_URL;
if (!gardenApiUrl) {
  throw new Error('GARDEN_API_URL is not set');
}

const evmRpcUrl = process.env.EVM_RPC_URL;
if (!evmRpcUrl) {
  throw new Error('EVM_RPC_URL is not set');
}

type SupportedMainnetAssets = typeof SupportedAssets.mainnet;
const mainnetAssets: {
  [K in string]?: SupportedMainnetAssets[keyof SupportedMainnetAssets];
} = SupportedAssets.mainnet;
const fromAssetKey = process.env.FROM_ASSET_KEY;
if (!fromAssetKey) {
  throw new Error('FROM_ASSET_KEY is not set');
}
const fromAsset = mainnetAssets[fromAssetKey];
if (!fromAsset) {
  throw new Error(`Invalid FROM_ASSET_KEY: ${fromAssetKey}`);
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC is not set');
}

const toAssetKey = process.env.TO_ASSET_KEY;
if (!toAssetKey) {
  throw new Error('TO_ASSET_KEY is not set');
}
const toAsset = mainnetAssets[toAssetKey];
if (!toAsset) {
  throw new Error(`Invalid TO_ASSET_KEY: ${toAssetKey}`);
}
// #endregion

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

export const getQuote = (props: {
  amountUnit: number;
  fromAsset: Asset;
  toAsset: Asset;
}) => {
  const account = mnemonicToAccount(mnemonic);
  const digestKeyResult = DigestKey.generateRandom();
  if (digestKeyResult.error) {
    throw new Error(`Invalid digest key: ${digestKeyResult.error}`);
  }
  const viemChain: Chain | undefined =
    evmToViemChainMap[fromAsset.chain] || evmToViemChainMap[toAsset.chain];
  if (!viemChain) {
    throw new Error(
      'Neither from chain "' +
        fromAsset.chain +
        '" or to chain "' +
        toAsset.chain +
        '" are EVM chains',
    );
  }
  const evmWalletClient = createWalletClient({
    account,
    chain: viemChain,
    transport: http(evmRpcUrl),
  });
  const garden = Garden.fromWallets({
    environment: Environment.MAINNET,
    digestKey: digestKeyResult.val,
    wallets: {
      evm: evmWalletClient,
    },
  });
  const sendAmount = props.amountUnit * 10 ** props.fromAsset.decimals;
  const orderPair = constructOrderPair({
    fromAsset: props.fromAsset,
    toAsset: props.toAsset,
  });
  console.dir(
    {
      digestKeyResult,
      quoteProps: props,
    },
    { depth: null },
  );
  return garden.quote
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
      return garden.swap(swapParams) as unknown as Promise<
        Result<MatchedOrder, string>
      >;
    })
    .then<Result<null | string | { depositAddress: string }, string>>(
      (result) => {
        if (result.val === null || result.error) {
          return new Result(false, null, result.error);
        }
        const matchedOrder = result.val;
        console.dir({ matchedOrder }, { depth: null });
        if (isEVM(fromAsset.chain)) {
          if (!garden.evmHTLC) {
            // note that EVM HTLC is required to swap
            return new Result(false, null, 'EVM HTLC is not available');
          }
          return garden.evmHTLC.initiate(matchedOrder);
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
      if (typeof initResult.val === 'object') {
        return new Result(true, initResult.val);
      }
      const inboundTx = initResult.val;
      console.log({ inboundTx });
      return garden.execute().then(() => {
        return Promise.any([
          new Promise<Result<null, string>>((resolve) => {
            const onError = (_: MatchedOrder, error: string) => {
              garden.off('error', onError);
              resolve(new Result(false, null, error));
            };
            garden.on('error', onError);
          }),
          new Promise<
            Result<{ orderAction: OrderActions; outboundTx: string }, string>
          >((resolve) => {
            const onSuccess = (
              _: MatchedOrder,
              orderAction: OrderActions,
              outboundTx: string,
            ) => {
              garden.off('success', onSuccess);
              resolve(new Result(true, { orderAction, outboundTx }));
            };
            garden.on('success', onSuccess);
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

if (import.meta.main) {
  getQuote({
    amountUnit,
    fromAsset,
    toAsset,
  });
}
