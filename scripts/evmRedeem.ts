import { SupportedAssets } from '@gardenfi/orderbook';
import { createEvmRedeemTx, evmWalletClient } from '../src/evm';

type SupportedMainnetAssets = typeof SupportedAssets.mainnet;
const mainnetAssets: {
  [K in string]?: SupportedMainnetAssets[keyof SupportedMainnetAssets];
} = SupportedAssets.mainnet;

const toAssetKey = process.env.TO_ASSET_KEY;
if (!toAssetKey) {
  throw new Error('TO_ASSET_KEY is not set');
}
const toAsset = mainnetAssets[toAssetKey];
if (!toAsset) {
  throw new Error('Invalid TO_ASSET_KEY: ' + toAssetKey);
}
const contractAddress = toAsset.atomicSwapAddress;
const orderId = process.env.ORDER_ID;
if (!orderId) {
  throw new Error('ORDER_ID is not defined');
}
const secret = process.env.SECRET;
if (!secret) {
  throw new Error('SECRET is not defined');
}

const redeemTx = createEvmRedeemTx({
  contractAddress,
  orderId,
  secret,
});
evmWalletClient.sendTransaction(redeemTx).then((outboundTx) => {
  return { ok: true, val: outboundTx };
});
