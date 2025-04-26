import { createWalletClient, http } from 'viem';
import { arbitrum } from 'viem/chains';
import {
  Garden,
  // Quote,
} from '@gardenfi/core';
import { Environment, DigestKey } from '@gardenfi/utils';
import { mnemonicToAccount } from 'viem/accounts';
import { type Asset, SupportedAssets } from '@gardenfi/orderbook';

const amountUnit = Number.parseFloat(process.env.AMOUNT_UNIT ?? '');
if (Number.isNaN(amountUnit)) {
  throw new Error('AMOUNT_UNIT is not set');
}

const digestKeyResult = DigestKey.generateRandom();
if (digestKeyResult.error) {
  throw new Error(`Invalid digest key: ${digestKeyResult.error}`);
}

const gardenApiUrl = process.env.GARDEN_API_URL;
if (!gardenApiUrl) {
  throw new Error('GARDEN_API_URL is not set');
}

const evmRpcUrl = process.env.ARB_RPC_URL;
if (!evmRpcUrl) {
  throw new Error('ARB_RPC_URL is not set');
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC is not set');
}

const account = mnemonicToAccount(mnemonic);
const ethereumWalletClient = createWalletClient({
  account,
  chain: arbitrum,
  transport: http(evmRpcUrl),
});

const garden = Garden.fromWallets({
  environment: Environment.MAINNET,
  digestKey: digestKeyResult.val,
  wallets: {
    evm: ethereumWalletClient,
  },
});

const fromAsset = SupportedAssets.mainnet.arbitrum_WBTC;
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
  exactOut,
  orderPair,
  sendAmount,
});
quote.getQuote(orderPair, sendAmount, exactOut).then((quoteResult) => {
  if (quoteResult.error) {
    console.dir(quoteResult.error, { depth: null });
    return;
  }
  console.dir(quoteResult.val, { depth: null });
});
