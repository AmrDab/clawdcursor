/**
 * Consent collected by a host's own UI. The Claude Desktop extension (.mcpb)
 * asks "Allow clawdcursor to control this computer" at install and passes the
 * answer as CLAWDCURSOR_CONSENT — an extension user never opens a terminal.
 * Only an explicit true/1 may record consent. Runs against a temp home dir so
 * the real ~/.clawdcursor/consent is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const home = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-consent-'));
});
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

import { acceptConsentFromEnv, hasConsent } from '../surface/onboarding';

const consentFile = path.join(home, '.clawdcursor', 'consent');

beforeEach(() => { fs.rmSync(path.join(home, '.clawdcursor'), { recursive: true, force: true }); });

describe('acceptConsentFromEnv', () => {
  it.each(['true', 'TRUE', '1', ' true '])('records consent for %j, noting where it came from', (v) => {
    expect(acceptConsentFromEnv({ CLAWDCURSOR_CONSENT: v })).toBe(true);
    expect(hasConsent()).toBe(true);
    expect(JSON.parse(fs.readFileSync(consentFile, 'utf8')).source).toBe('host-setting:CLAWDCURSOR_CONSENT');
  });

  it.each([undefined, '', 'false', '0', 'yes', '${user_config.allow_desktop_control}'])('does nothing for %j', (v) => {
    expect(acceptConsentFromEnv(v === undefined ? {} : { CLAWDCURSOR_CONSENT: v })).toBe(false);
    expect(hasConsent()).toBe(false);
  });

  it('never rewrites consent that already exists', () => {
    fs.mkdirSync(path.dirname(consentFile), { recursive: true });
    fs.writeFileSync(consentFile, '{"accepted":true,"source":"cli"}');
    expect(acceptConsentFromEnv({ CLAWDCURSOR_CONSENT: 'true' })).toBe(false);
    expect(fs.readFileSync(consentFile, 'utf8')).toBe('{"accepted":true,"source":"cli"}');
  });
});
