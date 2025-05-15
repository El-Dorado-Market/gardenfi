import { API } from '@gardenfi/core';
import { SupportedAssets } from '@gardenfi/orderbook';
import { DigestKey } from '@gardenfi/utils';

export const api = API.mainnet;

const digestKey = process.env.DIGEST_KEY;
const digestKeyResult = digestKey && DigestKey.from(digestKey);
if (!digestKeyResult || !digestKeyResult.val || digestKeyResult.error) {
  throw new Error('Invalid digest key: ' + digestKeyResult);
}
console.dir({ digestKey }, { depth: null });
const digestKeyVal = digestKeyResult.val;
export { digestKeyVal as digestKey };

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
  throw new Error('Invalid FROM_ASSET_KEY: ' + fromAssetKey);
}
const fromAssetValue = fromAsset;
export { fromAssetValue as fromAsset };

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC is not set');
}
const mnemonicValue = mnemonic;
export { mnemonicValue as mnemonic };

const toAssetKey = process.env.TO_ASSET_KEY;
if (!toAssetKey) {
  throw new Error('TO_ASSET_KEY is not set');
}
const toAsset = mainnetAssets[toAssetKey];
if (!toAsset) {
  throw new Error('Invalid TO_ASSET_KEY: ' + toAssetKey);
}
const toAssetValue = toAsset;
export { toAssetValue as toAsset };
