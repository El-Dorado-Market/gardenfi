import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import {
  Garden,
  type OrderActions,
  type SwapParams,
  // Quote,
} from '@gardenfi/core';
import { Environment, DigestKey, Result } from '@gardenfi/utils';
import { mnemonicToAccount } from 'viem/accounts';
import {
  type Asset,
  isEVM,
  type MatchedOrder,
  SupportedAssets,
} from '@gardenfi/orderbook';

const amountUnit = Number.parseFloat(process.env.AMOUNT_UNIT ?? '');
if (Number.isNaN(amountUnit)) {
  throw new Error('AMOUNT_UNIT is not set');
}

const btcAddress = process.env.BTC_ADDRESS;
if (!btcAddress) {
  throw new Error('BTC_ADDRESS is not set');
}

const digestKeyResult = DigestKey.generateRandom();
if (digestKeyResult.error) {
  throw new Error(`Invalid digest key: ${digestKeyResult.error}`);
}

const gardenApiUrl = process.env.GARDEN_API_URL;
if (!gardenApiUrl) {
  throw new Error('GARDEN_API_URL is not set');
}

const evmRpcUrl = process.env.EVM_RPC_URL;
if (!evmRpcUrl) {
  throw new Error('EVM_RPC_URL is not set');
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC is not set');
}

const account = mnemonicToAccount(mnemonic);
const evmWalletClient = createWalletClient({
  account,
  // chain: arbitrum,
  chain: base,
  transport: http(evmRpcUrl),
});

const garden = Garden.fromWallets({
  environment: Environment.MAINNET,
  digestKey: digestKeyResult.val,
  wallets: {
    evm: evmWalletClient,
  },
});

// const fromAsset = SupportedAssets.mainnet.arbitrum_WBTC;
const fromAsset = SupportedAssets.mainnet.base_cbBTC;
const toAsset = SupportedAssets.mainnet.bitcoin_BTC;
const sendAmount = amountUnit * 10 ** fromAsset.decimals;
const constructOrderPair = ({
  fromAsset,
  toAsset,
}: { fromAsset: Asset; toAsset: Asset }) => {
  return (
    fromAsset.chain +
    ':' +
    fromAsset.atomicSwapAddress +
    '::' +
    toAsset.chain +
    ':' +
    toAsset.atomicSwapAddress
  );
};
const orderPair = constructOrderPair({ fromAsset, toAsset });

const exactOut = false;
// const quote = new Quote(gardenApiUrl);
const quote = garden.quote;
console.log({
  quoteParams: {
    exactOut,
    orderPair,
    sendAmount,
  },
});
quote
  .getQuote(orderPair, sendAmount, exactOut)
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
      fromAsset,
      toAsset,
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
