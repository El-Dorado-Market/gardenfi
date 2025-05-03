import { Siwe, Url } from '@gardenfi/utils';
import { api, digestKey } from './utils';

export const auth = Siwe.fromDigestKey(new Url(api.auth), digestKey);
