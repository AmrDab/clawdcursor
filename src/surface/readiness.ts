/**
 * Readiness — single source of truth for Clawd Cursor operational status.
 * 
 * Consolidates:
 * - Consent status
 * - macOS permissions (Accessibility, Screen Recording)
 * - Overall readiness for desktop control
 */

import * as path from 'path';
import * as os from 'os';
import pc from 'picocolors';
import { hasConsent } from './onboarding';
import { checkPermissionsQuick, isMacOS } from '../platform/native-helper';

export interface ReadinessStatus {
  // Core requirements
  consent: {
    granted: boolean;
    file: string;
  };
  
  // macOS-specific permissions (null on other platforms)
  macPermissions: {
    accessibility: boolean;
    screenRecording: boolean | null;   // null: could not check
  } | null;
  
  // Overall status
  readyForDesktopControl: boolean;
  
  // Human-readable summary
  issues: string[];
  nextSteps: string[];
}

/**
 * Get full readiness status — the single source of truth.
 */
export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const consentDir = path.join(os.homedir(), '.clawdcursor');
  const consentFile = path.join(consentDir, 'consent');
  
  // Check consent
  const consentGranted = hasConsent();
  
  // Check macOS permissions (only on macOS)
  let macPermissions: ReadinessStatus['macPermissions'] = null;
  if (isMacOS()) {
    try {
      const perms = await checkPermissionsQuick();
      macPermissions = {
        accessibility: perms.accessibility,
        screenRecording: perms.screenRecording,
      };
    } catch {
      // If native helper isn't built yet, assume unknown
      macPermissions = {
        accessibility: false,
        screenRecording: false,
      };
    }
  }
  
  // Determine issues and next steps
  const issues: string[] = [];
  const nextSteps: string[] = [];
  
  if (!consentGranted) {
    issues.push('Desktop control consent not granted');
    nextSteps.push('Run: clawdcursor consent');
  }
  
  if (isMacOS() && macPermissions) {
    if (!macPermissions.accessibility) {
      issues.push('macOS Accessibility permission not granted');
      nextSteps.push('System Settings → Privacy & Security → Accessibility → Enable ClawdCursor');
    }
    if (macPermissions.screenRecording === false) {
      issues.push('macOS Screen Recording permission not granted');
      nextSteps.push('System Settings → Privacy & Security → Screen & System Audio Recording → Enable the app running clawdcursor (terminal or MCP host)');
    }
  }
  
  // Determine overall readiness
  const hasRequiredPermissions = !isMacOS() || (macPermissions?.accessibility ?? false);
  const readyForDesktopControl = consentGranted && hasRequiredPermissions;
  
  return {
    consent: {
      granted: consentGranted,
      file: consentFile,
    },
    macPermissions,
    readyForDesktopControl,
    issues,
    nextSteps,
  };
}

/**
 * Print a formatted status report to console.
 */
export async function printStatusReport(): Promise<void> {
  const status = await getReadinessStatus();

  const check = (ok: boolean) => ok ? pc.green('✓') : pc.red('✗');
  const warn = (ok: boolean) => ok ? pc.green('✓') : pc.yellow('⚠');

  console.log(`\n${pc.bold('🐾 Clawd Cursor Status')}\n`);
  console.log(pc.gray('─'.repeat(50)));

  // Consent
  console.log(`${check(status.consent.granted)} Consent: ${status.consent.granted ? 'Granted' : 'Not granted'}`);

  // macOS Permissions
  if (status.macPermissions) {
    console.log(`${check(status.macPermissions.accessibility)} Accessibility: ${status.macPermissions.accessibility ? 'Granted' : 'Not granted'}`);
    const sr = status.macPermissions.screenRecording;
    console.log(`${warn(sr === true)} Screen Recording: ${sr === null ? 'Could not check' : sr ? 'Granted' : 'Not granted'} ${!sr ? pc.gray('(optional)') : ''}`);
  } else if (process.platform !== 'darwin') {
    console.log(`${pc.green('✓')} Platform: ${process.platform} ${pc.gray('(no special permissions needed)')}`);
  }

  console.log(pc.gray('─'.repeat(50)));

  // Overall Status
  if (status.readyForDesktopControl) {
    console.log(`\n${pc.green(pc.bold('✓ Ready for desktop control'))}\n`);
  } else {
    console.log(`\n${pc.red(pc.bold('✗ Not ready for desktop control'))}\n`);
  }

  // Next Steps
  if (status.nextSteps.length > 0) {
    console.log(pc.bold('Next steps:'));
    status.nextSteps.forEach((step, i) => {
      console.log(`  ${i + 1}. ${step}`);
    });
    console.log('');
  }
}
