import { evmToViemChainMap } from '@gardenfi/core';
import { fromAsset, toAsset } from './utils';
import { mnemonicToAccount } from 'viem/accounts';
import {
  type Address,
  type Hex,
  type Chain as ViemChain,
  createWalletClient,
  encodeAbiParameters,
  getContract,
  http,
  isHex,
  parseAbiParameters,
  sha256,
} from 'viem';
import { with0x, type Result } from '@gardenfi/utils';
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

export const evmRedeem = ({
  contractAddress,
  initiatorAddress,
  secret,
}: {
  contractAddress: string;
  initiatorAddress: string;
  secret: string;
}): Promise<Result<string, string>> => {
  if (!isHex(contractAddress)) {
    return Promise.resolve({
      error: 'Invalid contract address: ' + contractAddress,
      ok: false,
    });
  }
  if (!isHex(initiatorAddress)) {
    return Promise.resolve({
      error: 'Invalid initiator address: ' + initiatorAddress,
      ok: false,
    });
  }
  const secretWith0x = with0x(secret);
  const secretHash = sha256(secretWith0x);
  const orderId = getOrderId({
    initiatorAddress: initiatorAddress,
    secretHash,
  });
  const contract = getContract({
    address: contractAddress,
    abi: AtomicSwapABI,
    client: evmWalletClient,
  });
  return contract.write
    .redeem([orderId, secretWith0x], {
      account,
    })
    .then((outboundTx) => {
      return { ok: true, val: outboundTx };
    });
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

export const evmRefund = ({
  contractAddress,
  initiatorAddress,
  secret,
}: {
  contractAddress: string;
  initiatorAddress: string;
  secret: string;
}): Promise<Result<string, string>> => {
  if (!isHex(contractAddress)) {
    return Promise.resolve({
      error: 'Invalid contract address: ' + contractAddress,
      ok: false,
    });
  }
  if (!isHex(initiatorAddress)) {
    return Promise.resolve({
      error: 'Invalid initiator address: ' + initiatorAddress,
      ok: false,
    });
  }
  const secretWith0x = with0x(secret);
  const secretHash = sha256(secretWith0x);
  const orderId = getOrderId({ initiatorAddress, secretHash });

  const contract = getContract({
    address: contractAddress,
    abi: AtomicSwapABI,
    client: evmWalletClient,
  });

  return contract.write
    .refund([orderId], {
      account: initiatorAddress,
      chain: undefined,
    })
    .then((refundTx) => {
      return {
        ok: true,
        val: refundTx,
      };
    });
};
