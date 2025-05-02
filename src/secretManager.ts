import * as ecc from 'tiny-secp256k1';
import ECPairFactory from 'ecpair';
import { Err, Ok, trim0x } from '@catalogfi/utils';
import { with0x } from '@gardenfi/utils';
import { sha256 } from 'viem';

export const generateSecret = ({
  digestKey,
  nonce,
}: { digestKey: string; nonce: string }) => {
  const signature = signMessage({ digestKey, nonce });
  if (signature.error) {
    return Err(signature.error);
  }

  const secret = sha256(with0x(signature.val));
  const secretHash = sha256(secret);
  return Ok({ secret, secretHash });
};

export const signMessage = ({
  digestKey,
  nonce,
}: { digestKey: string; nonce: string }) => {
  const ECPair = ECPairFactory(ecc);

  const signMessage = 'Garden.fi' + nonce.toString();
  const signMessageBuffer = Buffer.from(signMessage, 'utf8');
  const hash = sha256(signMessageBuffer);

  const digestKeyBuf = Buffer.from(trim0x(digestKey), 'hex');
  if (digestKeyBuf.length !== 32) {
    return Err('Invalid private key length. Expected 32 bytes.');
  }
  const keyPair = ECPair.fromPrivateKey(digestKeyBuf);
  const signature = keyPair.sign(Buffer.from(trim0x(hash), 'hex'));
  return Ok(signature.toString('hex'));
};
