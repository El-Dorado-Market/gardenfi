import { EvmRelay, evmToViemChainMap } from '@gardenfi/core';
import { api, fromAsset, toAsset } from './utils';
import { mnemonicToAccount } from 'viem/accounts';
import { type Chain as ViemChain, createWalletClient, http } from 'viem';
import { auth } from './auth';

const evmRpcUrl = process.env.EVM_RPC_URL;
if (!evmRpcUrl) {
  throw new Error('EVM_RPC_URL is not set');
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC is not set');
}

export const account = mnemonicToAccount(mnemonic);

const viemChain: ViemChain | undefined =
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
export const evmWalletClient = createWalletClient({
  account,
  chain: viemChain,
  transport: http(evmRpcUrl),
});

export const evmHTLC = new EvmRelay(api.evmRelay, evmWalletClient, auth);
