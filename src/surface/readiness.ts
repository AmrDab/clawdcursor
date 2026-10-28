/**
 * Readiness — single source of truth for Clawd Cursor operational status.
 * 
 * Consolidates:
 * - Consent status
 * - macOS permissions (Accessibility, Screen Recording)
 * - AI provider configuration
 * - Overall readiness for desktop control
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import pc from 'picocolors';
import { hasConsent } from './onboarding';
import { checkPermissionsQuick, isMacOS } from '../platform/native-helper';
import { getPackageRoot } from '../paths';

const CONFIG_FILE = '.clawdcursor-config.json';

export interface ReadinessStatus {
  // Core requirements
  consent: {
    granted: boolean;
    file: string;
  };
  
  // macOS-specific permissions (null on other platforms)
  macPermissions: {
    accessibility: boolean;
    screenRecording: boolean;
  } | null;
  
  // AI configuration
  aiConfig: {
    configured: boolean;
    configFile: string;
    hasTextModel: boolean;
    hasVisionModel: boolean;
  };
  
  // Overall status
  ready: boolean;
  readyForDesktopControl: boolean;
  
  // Human-readable summary
  issues: string[];
  nextSteps: string[];
}

/**
 * Check if AI config exists and has models configured
 */
function getCandidateConfigPaths(): string[] {
  const candidates = [
    path.join(process.cwd(), CONFIG_FILE),
    path.join(os.homedir(), 'clawdcursor', CONFIG_FILE),
    path.join(getPackageRoot(), CONFIG_FILE),
  ];

  return Array.from(new Set(candidates));
}

function checkAiConfig(): { configured: boolean; hasTextModel: boolean; hasVisionModel: boolean; configFile: string } {
  const configPath = getCandidateConfigPaths().find(p => fs.existsSync(p));

  if (!configPath) {
    return { configured: false, hasTextModel: false, hasVisionModel: false, configFile: getCandidateConfigPaths()[0] };
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const textLayer = config.pipeline?.textModel ?? config.pipeline?.layer2;
    const visionLayer = config.pipeline?.visionModel ?? config.pipeline?.layer3;
    const hasTextModel = !!(textLayer?.model || config.textModel || config.layer2?.model);
    const hasVisionModel = !!(visionLayer?.model || config.visionModel || config.layer3?.model);
    return { configured: true, hasTextModel, hasVisionModel, configFile: configPath };
  } catch {
    return { configured: false, hasTextModel: false, hasVisionModel: false, configFile: configPath };
  }
}

/**
 * Get full readiness status — the single source of truth.
 */
export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const consentDir = path.join(os.homedir(), '.clawdcursor');
  const consentFile = path.join(consentDir, 'consent');
  const configFile = getCandidateConfigPaths()[0];
  
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
  
  // Check AI config
  const aiConfig = checkAiConfig();
  
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
    if (!macPermissions.screenRecording) {
      issues.push('macOS Screen Recording permission not granted');
      nextSteps.push('System Settings → Privacy & Security → Screen & System Audio Recording → Enable the app running clawdcursor (terminal or MCP host)');
    }
  }
  
  if (!aiConfig.configured) {
    issues.push('AI provider not configured');
    nextSteps.push('Run: clawdcursor doctor');
  } else if (!aiConfig.hasTextModel && !aiConfig.hasVisionModel) {
    issues.push('No AI models configured');
    nextSteps.push('Run: clawdcursor doctor');
  }
  
  // Determine overall readiness
  const hasRequiredPermissions = !isMacOS() || (macPermissions?.accessibility ?? false);
  const readyForDesktopControl = consentGranted && hasRequiredPermissions;
  const ready = readyForDesktopControl && aiConfig.configured;
  
  return {
    consent: {
      granted: consentGranted,
      file: consentFile,
    },
    macPermissions,
    aiConfig: {
      ...aiConfig,
      configFile: aiConfig.configFile || configFile,
    },
    ready,
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
    console.log(`${warn(status.macPermissions.screenRecording)} Screen Recording: ${status.macPermissions.screenRecording ? 'Granted' : 'Not granted'} ${!status.macPermissions.screenRecording ? pc.gray('(optional)') : ''}`);
  } else if (process.platform !== 'darwin') {
    console.log(`${pc.green('✓')} Platform: ${process.platform} ${pc.gray('(no special permissions needed)')}`);
  }

  // AI Config
  console.log(`${check(status.aiConfig.configured)} AI Config: ${status.aiConfig.configured ? 'Found' : 'Not configured'}`);
  if (status.aiConfig.configured) {
    console.log(`  ${check(status.aiConfig.hasTextModel)} Text model: ${status.aiConfig.hasTextModel ? 'Configured' : 'Not set'}`);
    console.log(`  ${warn(status.aiConfig.hasVisionModel)} Vision model: ${status.aiConfig.hasVisionModel ? 'Configured' : 'Not set'} ${!status.aiConfig.hasVisionModel ? pc.gray('(optional)') : ''}`);
  }

  console.log(pc.gray('─'.repeat(50)));

  // Overall Status
  if (status.ready) {
    console.log(`\n${pc.green(pc.bold('✓ Ready for desktop control'))}\n`);
  } else if (status.readyForDesktopControl) {
    console.log(`\n${pc.yellow(pc.bold('⚠ Desktop control ready, but AI not configured'))}`);
    console.log(`  Layer 1 (Action Router) will work without AI.\n`);
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

/**
 * Quick check if basic requirements are met (for gating commands).
 */
export async function isReadyForDesktopControl(): Promise<boolean> {
  const status = await getReadinessStatus();
  return status.readyForDesktopControl;
}

/**
 * Get a one-line summary suitable for doctor output.
 */
export async function getReadinessSummary(): Promise<string> {
  const status = await getReadinessStatus();
  
  if (status.ready) {
    return '✓ All systems ready';
  } else if (status.readyForDesktopControl) {
    return '⚠ Desktop ready, AI not configured';
  } else {
    return `✗ ${status.issues.length} issue(s): ${status.issues.slice(0, 2).join(', ')}`;
  }
}
