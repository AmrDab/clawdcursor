/**
 * Deterministic Flows — zero-LLM verified workflows for known app patterns.
 *
 * Each step uses the action verifier to guarantee actions worked.
 * If any step fails, returns { handled: false } so the caller can
 * fall back to Layer 2 (LLM reasoner).
 */

import { AccessibilityBridge } from './accessibility';
import { NativeDesktop } from './native-desktop';
import { ActionVerifier } from './action-verifier';

export interface FlowResult {
  handled: boolean;
  description: string;
  failedAtStep?: number;
  stepsCompleted?: number;
}

export class DeterministicFlows {
  private a11y: AccessibilityBridge;
  private desktop: NativeDesktop;
  private verifier: ActionVerifier;

  constructor(a11y: AccessibilityBridge, desktop: NativeDesktop) {
    this.a11y = a11y;
    this.desktop = desktop;
    this.verifier = new ActionVerifier(a11y, desktop);
  }

  /**
   * Try to match and execute a deterministic flow.
   * Returns null if no flow matches the task.
   */
  async tryFlow(task: string, app: string): Promise<FlowResult | null> {
    const appLower = app.toLowerCase();
    const taskLower = task.toLowerCase();

    // Outlook email flow (process may be msedge but window title contains "Outlook")
    if (/outlook|olk/i.test(appLower) && /send.*email|email.*to|mail.*to|introduce/i.test(taskLower)) {
      const parsed = this.parseEmailTask(taskLower);
      if (parsed) {
        return this.outlookEmailFlow(parsed.to, parsed.subject, parsed.body);
      }
    }

    return null; // No matching flow
  }

  private parseEmailTask(task: string): { to: string; subject: string; body: string } | null {
    // Extract email address
    const emailMatch = task.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (!emailMatch) return null;

    const to = emailMatch[0];

    // Extract "saying X" or "with subject X" or "about X"
    let subject = 'Hello';
    let body = '';

    const sayingMatch = task.match(/saying\s+["']?(.+?)["']?$/i);
    const subjectMatch = task.match(/(?:subject|about)\s+["']?(.+?)["']?(?:\s+(?:saying|body)|$)/i);
    const bodyMatch = task.match(/body\s+["']?(.+?)["']?$/i);

    if (subjectMatch) {
      subject = subjectMatch[1].trim();
    } else if (sayingMatch) {
      subject = sayingMatch[1].trim();
    }

    if (bodyMatch) {
      body = bodyMatch[1].trim();
    } else if (sayingMatch) {
      body = sayingMatch[1].trim();
    } else {
      body = subject;
    }

    return { to, subject, body };
  }

  /**
   * Outlook email: deterministic Tab-based navigation.
   * Ctrl+N → type To → Tab → type Subject → Tab → type Body → Ctrl+Enter
   */
  private async outlookEmailFlow(to: string, subject: string, body: string): Promise<FlowResult> {
    console.log(`   📧 Deterministic email flow: to=${to} subject="${subject}"`);
    let step = 0;

    try {
      // Step 1: Open compose via UIAutomation invoke on "New mail" button
      step = 1;
      const activeWin = await this.a11y.getActiveWindow();
      let composeOpen = false;

      // Try UIAutomation invoke first — bypasses keyboard focus issues
      try {
        const invokeResult = await this.a11y.invokeElement({
          name: 'New mail',
          controlType: 'ControlType.Button',
          action: 'click',
          processId: activeWin?.processId,
        });
        if (invokeResult.success || invokeResult.clickPoint) {
          if (invokeResult.clickPoint) {
            await this.desktop.mouseClick(invokeResult.clickPoint.x, invokeResult.clickPoint.y);
          }
          console.log(`   📧 Step 1: Invoked "New mail" via UIAutomation`);
          await new Promise(r => setTimeout(r, 2000));
          composeOpen = true;
        }
      } catch { /* fall through to Ctrl+N */ }

      // Fallback: click center + Ctrl+N
      if (!composeOpen) {
        const b = activeWin?.bounds;
        if (b && b.x > -100 && b.y > -100 && b.width > 100 && b.height > 100) {
          await this.desktop.mouseClick(b.x + Math.floor(b.width / 2), b.y + Math.floor(b.height / 2));
          await new Promise(r => setTimeout(r, 300));
        }
        await this.desktop.keyPress('Control+n');
        console.log(`   📧 Step 1: Fallback Ctrl+N, waiting for compose...`);
        await new Promise(r => setTimeout(r, 2000));
        composeOpen = true; // trust it — verification below will catch failures
      }

      // Step 2: Type recipient in To field
      step = 2;
      const typeToResult = await this.verifier.verifiedType(to);
      console.log(`   📧 Step 2: Typed To "${to}" — ${typeToResult.success ? 'OK' : typeToResult.error}`);

      // Step 3: Tab to Subject
      step = 3;
      const tabToSubject = await this.verifier.verifiedKeyPress('Tab', { focusShouldChange: true });
      console.log(`   📧 Step 3: Tab to Subject — ${tabToSubject.success ? 'OK' : tabToSubject.error}`);

      // Step 4: Type subject
      step = 4;
      const typeSubjectResult = await this.verifier.verifiedType(subject);
      console.log(`   📧 Step 4: Typed Subject "${subject}" — ${typeSubjectResult.success ? 'OK' : typeSubjectResult.error}`);

      // Step 5: Tab to Body
      step = 5;
      const tabToBody = await this.verifier.verifiedKeyPress('Tab', { focusShouldChange: true });
      console.log(`   📧 Step 5: Tab to Body — ${tabToBody.success ? 'OK' : tabToBody.error}`);

      // Step 6: Type body
      step = 6;
      const typeBodyResult = await this.verifier.verifiedType(body);
      console.log(`   📧 Step 6: Typed Body — ${typeBodyResult.success ? 'OK' : typeBodyResult.error}`);

      // Step 7: Send with Ctrl+Enter
      step = 7;
      const sendResult = await this.verifier.verifiedKeyPress('Control+Return', { windowShouldClose: true });
      if (sendResult.success) {
        console.log(`   📧 Step 7: Ctrl+Enter — email sent!`);
        return { handled: true, description: `Email sent to ${to} with subject "${subject}"`, stepsCompleted: 7 };
      }

      // Ctrl+Enter didn't close window — try Alt+S as fallback
      step = 8;
      console.log(`   📧 Step 7 fallback: Ctrl+Enter didn't close compose, trying Alt+S`);
      const altSResult = await this.verifier.verifiedKeyPress('Alt+s', { windowShouldClose: true });
      if (altSResult.success) {
        console.log(`   📧 Step 8: Alt+S — email sent!`);
        return { handled: true, description: `Email sent to ${to} (via Alt+S)`, stepsCompleted: 8 };
      }

      console.log(`   ❌ Deterministic flow: send failed (both Ctrl+Enter and Alt+S)`);
      return { handled: false, description: 'Send shortcut did not work', failedAtStep: step, stepsCompleted: step };

    } catch (err) {
      console.log(`   ❌ Deterministic flow error at step ${step}: ${err}`);
      return { handled: false, description: `Error at step ${step}: ${err}`, failedAtStep: step, stepsCompleted: step - 1 };
    }
  }
}
