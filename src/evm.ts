import { evmToViemChainMap } from '@gardenfi/core';
import { fromAsset, toAsset } from './utils';
import { mnemonicToAccount } from 'viem/accounts';
import {
  type Address,
  type Hex,
  type SendTransactionRequest,
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
const viemChain = chainMap[fromAsset.chain] || chainMap[toAsset.chain];
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
  swapId,
  secret,
}: {
  contractAddress: string;
  swapId: string;
  secret: string;
}): EvmTransaction => {
  const data = encodeFunctionData({
    abi: AtomicSwapABI,
    functionName: 'redeem',
    args: [with0x(swapId), with0x(secret)],
  });
  return {
    data,
    to: with0x(contractAddress),
  };
};

/**
 * EVM refund is automatically done by relay service
 */
export const createEvmRefundTx = ({
  contractAddress,
  swapId,
}: {
  contractAddress: string;
  swapId: string;
}): EvmTransaction => {
  const data = encodeFunctionData({
    abi: AtomicSwapABI,
    functionName: 'refund',
    args: [with0x(swapId)],
  });
  return {
    data,
    to: with0x(contractAddress),
  };
};

export type EvmTransaction = SendTransactionRequest;

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

export const createEvmInitiateTx = (props: {
  amountSubunit: string;
  atomicSwapAddress: string;
  redeemer: string;
  secretHash: string;
  timelock: number;
}): EvmTransaction => {
  const amount = BigInt(props.amountSubunit);
  const atomicSwapAddress = with0x(props.atomicSwapAddress);
  const redeemer = with0x(props.redeemer);
  const secretHash = with0x(props.secretHash);
  const timelock = BigInt(props.timelock);
  const data = encodeFunctionData({
    abi: AtomicSwapABI,
    functionName: 'initiate',
    args: [redeemer, timelock, amount, secretHash],
  });
  return {
    data,
    to: atomicSwapAddress,
  };
};
