import { createHash, createHmac, randomUUID } from 'node:crypto';

// Adapted from AiToEarn buildSignedHeaders (11dd1957d0c69ae2b27a0b8a47acdf6675715558).
// Copyright (c) 2025 AiToEarn. See ../LICENSE-AiToEarn.
export function biliSignedHeaders(
  clientId: string, clientSecret: string, accessToken: string, payload: string,
) {
  const headers = {
    'x-bili-accesskeyid': clientId,
    'x-bili-content-md5': createHash('md5').update(payload).digest('hex'),
    'x-bili-signature-method': 'HMAC-SHA256',
    'x-bili-signature-nonce': randomUUID().replaceAll('-', ''),
    'x-bili-signature-version': '2.0',
    'x-bili-timestamp': String(Math.floor(Date.now() / 1000)),
  };
  const signaturePayload = Object.entries(headers)
    .map(([key, value]) => `${key}:${value}`)
    .join('\n');
  return {
    ...headers,
    Accept: 'application/json',
    'Access-Token': accessToken,
    Authorization: createHmac('sha256', clientSecret).update(signaturePayload).digest('hex'),
  };
}
