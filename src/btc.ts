import * as varuint from 'varuint-bitcoin';
import * as ecc from 'tiny-secp256k1';
import * as secp256k1 from 'tiny-secp256k1';
import {
  BitcoinNetwork,
  BitcoinProvider,
  BitcoinWallet,
  Urgency,
  type BitcoinUTXO,
} from '@catalogfi/wallets';
import { digestKey } from './utils';
import { toXOnly } from '@gardenfi/core';
import type { Result } from '@gardenfi/utils';
import * as bitcoin from 'bitcoinjs-lib';
import type { Taptree } from 'bitcoinjs-lib/src/types';

export const provider = new BitcoinProvider(BitcoinNetwork.Mainnet);
export const btcWallet = BitcoinWallet.fromPrivateKey(
  digestKey.digestKey,
  provider,
);

export const buildRawTx = ({
  expiry,
  fee,
  initiatorPubkey,
  internalPubkey,
  network,
  provider,
  receiver,
  redeemerPubkey,
  secretHash,
}: {
  expiry: number;
  fee?: number;
  initiatorPubkey: string;
  internalPubkey: Buffer;
  network: bitcoin.Network;
  provider: BitcoinProvider;
  receiver: string;
  redeemerPubkey: string;
  secretHash: string;
}): Promise<
  Result<
    { address: string; tx: bitcoin.Transaction; usedUtxos: Array<BitcoinUTXO> },
    string
  >
> => {
  const addressResult = generateAddress({
    expiry,
    initiatorPubkey,
    internalPubkey,
    network,
    redeemerPubkey,
    secretHash,
  });
  if (!addressResult.ok) {
    return Promise.resolve(addressResult);
  }
  const { val: address } = addressResult;
  return provider
    .getUTXOs(address)
    .then((utxos) => {
      const tx = new bitcoin.Transaction();
      tx.version = 2;
      return utxos.reduce(
        ({ balance, txWithInputs }, utxo) => {
          txWithInputs.addInput(
            Buffer.from(utxo.txid, 'hex').reverse(),
            utxo.vout,
          );
          return {
            balance: balance + utxo.value,
            txWithInputs,
            utxos,
          };
        },
        { balance: 0, txWithInputs: tx, utxos },
      );
    })
    .then(({ balance, txWithInputs, utxos }) => {
      if (fee) {
        return { balance, fee, txWithInputs, utxos };
      }
      return provider
        .suggestFee(address, balance, Urgency.MEDIUM)
        .then((fee) => {
          return { balance, fee, txWithInputs, utxos };
        });
    })
    .then(({ balance, fee, txWithInputs, utxos }) => {
      txWithInputs.addOutput(
        bitcoin.address.toOutputScript(receiver, network),
        balance - fee,
      );

      return { ok: true, val: { address, tx: txWithInputs, usedUtxos: utxos } };
    });
};

export const htlcErrors = {
  secretMismatch: 'invalid secret',
  secretHashLenMismatch: 'secret hash should be 32 bytes',
  pubkeyLenMismatch: 'pubkey should be 32 bytes',
  zeroOrNegativeExpiry: 'expiry should be greater than 0',
  htlcAddressGenerationFailed: 'failed to generate htlc address',
  notFunded: 'address not funded',
  noCounterpartySigs: 'counterparty signatures are required',
  counterPartySigNotFound: (utxo: string) =>
    'counterparty signature not found for utxo ' + utxo,
  invalidCounterpartySigForUTXO: (utxo: string) =>
    'invalid counterparty signature for utxo ' + utxo,
  htlcNotExpired: (blocks: number) =>
    `HTLC not expired, need more ${blocks} blocks`,
  controlBlockGenerationFailed: 'failed to generate control block',
  invalidLeaf: 'invalid leaf',
};

/**
 * order.source_swap.swap_id
 */
export const generateAddress = ({
  expiry,
  initiatorPubkey,
  internalPubkey,
  network,
  redeemerPubkey,
  secretHash,
}: {
  expiry: number;
  initiatorPubkey: string;
  internalPubkey: Buffer;
  network: bitcoin.Network;
  redeemerPubkey: string;
  secretHash: string;
}): Result<string, string> => {
  const payment = bitcoin.payments.p2tr({
    internalPubkey,
    network,
    scriptTree: getLeaves({
      expiry,
      initiatorPubkey,
      redeemerPubkey,
      secretHash,
    }),
  });
  if (!payment.address) {
    return { error: htlcErrors.htlcAddressGenerationFailed, ok: false };
  }
  return { ok: true, val: payment.address };
};

/**
 * Given a leaf, generates the control block necessary for spending the leaf
 */
export const generateControlBlockFor = ({
  expiry,
  initiatorPubkey,
  internalPubkey,
  leafScript,
  network,
  redeemerPubkey,
  secretHash,
}: {
  expiry: number;
  initiatorPubkey: string;
  internalPubkey: Buffer;
  leafScript: Buffer;
  network: bitcoin.Network;
  redeemerPubkey: string;
  secretHash: string;
}): Result<Buffer, string> => {
  const payment = bitcoin.payments.p2tr({
    internalPubkey,
    network,
    scriptTree: getLeaves({
      expiry,
      initiatorPubkey,
      redeemerPubkey,
      secretHash,
    }),
    redeem: {
      output: leafScript,
      redeemVersion: LEAF_VERSION,
    },
  });
  const firstWitness = payment.witness?.at(-1);
  if (!firstWitness) {
    return { error: htlcErrors.controlBlockGenerationFailed, ok: false };
  }
  return { ok: true, val: firstWitness };
};

// #region bip341
const errors = {
  failedToCreateInternalPubkey: 'failed to create internal pubkey',
  failedToTweakPubkey: 'failed to tweak pubkey',
};
const G_X = Buffer.from(
  '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  'hex',
);
const G_Y = Buffer.from(
  '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
  'hex',
);
const G = Buffer.concat([G_X, G_Y]);
const H = Buffer.from(
  '0250929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0',
  'hex',
);
// #endregion
export const generateInternalPubkey = (): Result<Buffer, string> => {
  const hash = bitcoin.crypto.sha256(Buffer.from('GardenHTLC', 'utf-8'));
  const R = ecc.pointMultiply(
    Buffer.concat([Buffer.from('04', 'hex'), G]),
    hash,
  );
  if (!R) {
    return { error: errors.failedToCreateInternalPubkey, ok: false };
  }
  const internalPubKey = ecc.pointAdd(H, R);
  if (!internalPubKey) {
    return { error: errors.failedToCreateInternalPubkey, ok: false };
  }
  const pubkey = Buffer.from(internalPubKey);
  return { ok: true, val: pubkey.subarray(1, 33) };
};

/**
 * We only have one output script aka scriptpubkey, hence we generate the same output for signing
 */
export const generateOutputScripts = ({
  address,
  count,
  network,
}: {
  address: string;
  count: number;
  network: bitcoin.Network;
}): Array<Buffer> => {
  const outputScript = bitcoin.address.toOutputScript(address, network);
  const outputs: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    outputs.push(outputScript);
  }
  return outputs;
};

export const getBtcAddress = (): Promise<Result<string, string>> => {
  return btcWallet.getPublicKey().then((pubKey) => {
    if (!pubKey || !isValidBitcoinPubKey({ pubKey })) {
      return { error: 'Invalid btc public key', ok: false };
    }
    return { ok: true, val: toXOnly(pubKey) };
  });
};

export const getBtcNetwork = () => {
  return bitcoin.networks.bitcoin;
};

/**
 * Generates the hash of the leaf script
 */
export const getLeafHash = ({
  leafScript,
}: {
  leafScript: Buffer;
}): Buffer => {
  return bitcoin.crypto.taggedHash(
    'TapLeaf',
    Buffer.concat([Uint8Array.from([0xc0]), prefixScriptLength(leafScript)]),
  );
};

export const getLeaves = ({
  expiry,
  initiatorPubkey,
  redeemerPubkey,
  secretHash,
}: {
  expiry: number;
  initiatorPubkey: string;
  redeemerPubkey: string;
  secretHash: string;
}): Taptree => {
  return [
    // most probable leaf (redeem)
    {
      version: LEAF_VERSION,
      output: redeemLeaf({ redeemerPubkey, secretHash }),
    },
    [
      {
        version: LEAF_VERSION,
        output: refundLeaf({ expiry, initiatorPubkey }),
      },
      {
        version: LEAF_VERSION,
        output: instantRefundLeaf({ initiatorPubkey, redeemerPubkey }),
      },
    ],
  ];
};

export const instantRefundLeaf = ({
  initiatorPubkey,
  redeemerPubkey,
}: { initiatorPubkey: string; redeemerPubkey: string }): Buffer => {
  return bitcoin.script.fromASM(
    [
      initiatorPubkey,
      'OP_CHECKSIG',
      redeemerPubkey,
      'OP_CHECKSIGADD',
      'OP_2',
      'OP_NUMEQUAL',
    ].join(' '),
  );
};

export const isValidBitcoinPubKey = ({
  pubKey,
}: { pubKey: string }): boolean => {
  if (!pubKey) {
    return false;
  }

  try {
    const pubKeyBuffer = Buffer.from(pubKey, 'hex');
    return secp256k1.isPoint(pubKeyBuffer);
  } catch {
    return false;
  }
};

export enum Leaf {
  REFUND = 0,
  REDEEM = 1,
  INSTANT_REFUND = 2,
}

export const LEAF_VERSION = 0xc0;

export const redeemLeaf = ({
  redeemerPubkey,
  secretHash,
}: { redeemerPubkey: string; secretHash: string }): Buffer => {
  return bitcoin.script.fromASM(
    [
      'OP_SHA256',
      secretHash,
      'OP_EQUALVERIFY',
      redeemerPubkey,
      'OP_CHECKSIG',
    ].join(' '),
  );
};

export const refundLeaf = ({
  expiry,
  initiatorPubkey,
}: { expiry: number; initiatorPubkey: string }): Buffer => {
  return bitcoin.script.fromASM(
    [
      bitcoin.script.number.encode(expiry).toString('hex'),
      'OP_CHECKSEQUENCEVERIFY',
      'OP_DROP',
      initiatorPubkey,
      'OP_CHECKSIG',
    ].join(' '),
  );
};

export const prefixScriptLength = (s: Buffer): Buffer => {
  const varintLen = varuint.encodingLength(s.length);
  const buffer = Buffer.allocUnsafe(varintLen);
  varuint.encode(s.length, buffer);
  return Buffer.concat([buffer, s]);
};
