import * as ecc from 'tiny-secp256k1';
import ECPairFactory from 'ecpair';
import { trim0x } from '@catalogfi/utils';
import { with0x, type Result } from '@gardenfi/utils';
import { sha256 } from 'viem';

export const generateSecret = ({
  digestKey,
  nonce,
}: { digestKey: string; nonce: string }): Result<
  { secret: string; secretHash: string },
  string
> => {
  const signature = signMessage({ digestKey, nonce });
  if (!signature.ok) {
    return { error: signature.error, ok: false };
  }

  const secret = sha256(with0x(signature.val));
  const secretHash = sha256(secret);
  return { ok: true, val: { secret, secretHash } };
};

export const signMessage = ({
  digestKey,
  nonce,
}: { digestKey: string; nonce: string }): Result<string, string> => {
  const ECPair = ECPairFactory(ecc);

  const signMessage = 'Garden.fi' + nonce.toString();
  const signMessageBuffer = Buffer.from(signMessage, 'utf8');
  const hash = sha256(signMessageBuffer);

  const digestKeyBuf = Buffer.from(trim0x(digestKey), 'hex');
  if (digestKeyBuf.length !== 32) {
    return {
      error: 'Invalid private key length. Expected 32 bytes.',
      ok: false,
    };
  }
  const keyPair = ECPair.fromPrivateKey(digestKeyBuf);
  const signature = keyPair.sign(Buffer.from(trim0x(hash), 'hex'));
  return { ok: true, val: signature.toString('hex') };
};
