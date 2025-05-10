import { evmToViemChainMap } from '@gardenfi/core';
import { fromAsset, toAsset } from './utils';
import { mnemonicToAccount } from 'viem/accounts';
import {
  type Address,
  type Hex,
  type Chain as ViemChain,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbiParameters,
  sha256,
} from 'viem';
import { with0x } from '@gardenfi/utils';
import { AtomicSwapABI } from './AtomicSwapABI';

const evmRpcUrl = process.env.EVM_RPC_URL;
if (!evmRpcUrl) {
  throw new Error('EVM_RPC_URL is not set');
}

const mnemonic = process.env.MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC is not set');
}

export const account = mnemonicToAccount(mnemonic);

export const chainMap: { [K in string]?: ViemChain } = evmToViemChainMap;
const viemChain: ViemChain | undefined =
  chainMap[fromAsset.chain] || chainMap[toAsset.chain];
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

export const createEvmRedeemTx = ({
  contractAddress,
  initiatorAddress,
  secret,
  secretHash,
}: {
  contractAddress: string;
  initiatorAddress: string;
  secret: string;
  secretHash: string;
}): EvmTransaction => {
  const secretWith0x = with0x(secret);
  const orderId = getOrderId({
    initiatorAddress: with0x(initiatorAddress),
    secretHash: with0x(secretHash),
  });
  console.log({
    redeemOrderId: orderId,
  });
  const data = encodeFunctionData({
    abi: AtomicSwapABI,
    functionName: 'redeem',
    args: [orderId, secretWith0x],
  });
  return {
    from: evmWalletClient.account.address,
    data,
    to: with0x(contractAddress),
    value: with0x('0'),
  };
};

/**
 * EVM refund is automatically done by relay service
 */
export const createEvmRefundTx = ({
  contractAddress,
  initiatorAddress,
  secretHash,
}: {
  contractAddress: string;
  initiatorAddress: string;
  secretHash: string;
}): EvmTransaction => {
  const orderId = getOrderId({
    initiatorAddress: with0x(initiatorAddress),
    secretHash: with0x(secretHash),
  });
  console.log({
    refundOrderId: orderId,
  });
  const data = encodeFunctionData({
    abi: AtomicSwapABI,
    functionName: 'refund',
    args: [with0x(orderId)],
  });
  return {
    data,
    from: evmWalletClient.account.address,
    to: with0x(contractAddress),
    value: with0x('0'),
  };
};

export type EvmTransaction = {
  from: string;
  data: string;
  to: string;
  value: string;
};

export const getOrderId = ({
  initiatorAddress,
  secretHash,
}: { initiatorAddress: Address; secretHash: Hex }) => {
  return sha256(
    encodeAbiParameters(parseAbiParameters(['bytes32', 'address']), [
      secretHash,
      initiatorAddress,
    ]),
  );
};
