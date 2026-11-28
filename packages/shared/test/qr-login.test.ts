import { describe, expect, it } from 'vitest';
import {
  assertQrTransition,
  canQrTransition,
  isTerminalQrState,
  QR_LOGIN_STATES,
  toLegacyQrStatus,
} from '../src/qr-login.js';

describe('QR login state machine', () => {
  it('defines all 10 expected states and terminal boundaries', () => {
    expect(QR_LOGIN_STATES).toHaveLength(10);
    expect(isTerminalQrState('CONNECTED')).toBe(true);
    expect(isTerminalQrState('QR_EXPIRED')).toBe(true);
    expect(isTerminalQrState('CANCELED')).toBe(true);
    expect(isTerminalQrState('WAITING_SCAN')).toBe(false);
    expect(isTerminalQrState('NETWORK_ERROR')).toBe(false);
  });

  it('prevents terminal CONNECTED state from reverting to WAITING_SCAN or QR_EXPIRED', () => {
    expect(canQrTransition('CONNECTED', 'WAITING_SCAN')).toBe(false);
    expect(canQrTransition('CONNECTED', 'QR_EXPIRED')).toBe(false);
    expect(() => assertQrTransition('CONNECTED', 'WAITING_SCAN')).toThrow();
    expect(canQrTransition('QR_EXPIRED', 'SCANNED')).toBe(false);
  });

  it('preserves business state mapping when reporting transient network or rate limit errors', () => {
    expect(toLegacyQrStatus('NETWORK_ERROR', 'WAITING_SCAN')).toBe('pending');
    expect(toLegacyQrStatus('NETWORK_ERROR', 'SCANNED')).toBe('scanned');
    expect(toLegacyQrStatus('RATE_LIMITED', 'SCANNED')).toBe('scanned');
    expect(toLegacyQrStatus('CONNECTED')).toBe('connected');
    expect(toLegacyQrStatus('QR_EXPIRED')).toBe('expired');
  });
});
