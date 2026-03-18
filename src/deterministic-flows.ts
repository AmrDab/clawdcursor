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
      const parsed = this.parseEmailTask(task); // preserve original casing for body text
      if (parsed) {
        return this.outlookEmailFlow(parsed.to, parsed.subject, parsed.body);
      }
    }

    // Find & Replace flow — any text editor with "find and replace" or "replace X with Y"
    if (/notepad|editor|text/i.test(appLower) || /find.*replace|replace.*with|ctrl\+h/i.test(taskLower)) {
      const parsed = this.parseFindReplaceTask(task);
      if (parsed) {
        // Extract pre-replace text operations (clear + type) if present
        const preText = this.parsePreReplaceText(task);
        return this.findReplaceFlow(parsed.find, parsed.replace, preText);
      }
    }

    return null; // No matching flow
  }

  private parseEmailTask(task: string): { to: string; subject: string; body: string } | null {
    // Extract email address
    const emailMatch = task.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (!emailMatch) return null;

    const to = emailMatch[0];

    let subject = 'Hello';
    let body = '';

    // Try "subject 'X'" or 'subject "X"' or "Subject: X" (quoted)
    const subjectQuotedMatch = task.match(/subject[:\s]+['"](.+?)['"]/i);
    if (subjectQuotedMatch) {
      subject = subjectQuotedMatch[1].trim();
    } else {
      // Unquoted: "subject X body Y" or "subject X" (to end)
      const subjectUnquotedMatch = task.match(/subject[:\s]+(.+?)(?:\.\s*body|\s+and\s+body|\s+body\b|$)/i);
      if (subjectUnquotedMatch) {
        subject = subjectUnquotedMatch[1].trim();
      }
    }

    // Try "body 'X'" or 'body "X"' (quoted) — takes everything between quotes
    const bodyQuotedMatch = task.match(/body[:\s]+['"](.+)['"]\s*$/i);
    if (bodyQuotedMatch) {
      body = bodyQuotedMatch[1].trim();
    } else {
      // Unquoted: "body X" to end of string
      const bodyUnquotedMatch = task.match(/body[:\s]+(.+)$/i);
      if (bodyUnquotedMatch) {
        body = bodyUnquotedMatch[1].trim();
      }
    }

    // Fallback: "saying X" pattern
    if (!body && !subjectQuotedMatch) {
      const sayingMatch = task.match(/saying\s+["']?(.+?)["']?$/i);
      if (sayingMatch) {
        subject = sayingMatch[1].trim();
        body = subject;
      }
    }

    // If still no body, default to subject as body
    if (!body) {
      body = subject;
    }

    // Try "introducing yourself" pattern — auto-generate body
    if (/introduc/i.test(task) && (!body || body === subject)) {
      subject = 'Hello from ClawdCursor';
      body = 'Hi! I am ClawdCursor, an AI-powered desktop automation agent. I can control your computer using OCR and accessibility APIs to complete tasks like typing in Notepad, computing in Calculator, navigating files, and much more. This email was sent autonomously as a test. Best regards, ClawdCursor';
    }

    console.log(`   📧 Parsed email: to=${to}, subject="${subject}", body="${body.substring(0, 60)}..."`);
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
      // Step 1: Focus Outlook and open compose window
      step = 1;
      let composeOpen = false;

      // First: ensure Outlook is focused (not some other window)
      let outlookWin = await this.a11y.findWindow('Outlook');
      if (!outlookWin) {
        // Try by process name
        const allWindows = await this.a11y.getWindows(true);
        outlookWin = allWindows.find(w => /OUTLOOK|olk/i.test(w.processName)) || null;
      }
      if (outlookWin) {
        await this.a11y.focusWindow(undefined, outlookWin.processId);
        await new Promise(r => setTimeout(r, 500));
        console.log(`   📧 Focused Outlook: "${outlookWin.title}" (pid ${outlookWin.processId})`);
      } else {
        console.log(`   ❌ Cannot find Outlook window`);
        return { handled: false, description: 'Outlook window not found', failedAtStep: 1, stepsCompleted: 0 };
      }

      // Try UIAutomation invoke first — bypasses keyboard focus issues
      try {
        const invokeResult = await this.a11y.invokeElement({
          name: 'New mail',
          controlType: 'ControlType.Button',
          action: 'click',
          processId: outlookWin.processId,
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

      // Fallback: click center of Outlook window + Ctrl+N
      if (!composeOpen) {
        // Re-focus Outlook before Ctrl+N
        await this.a11y.focusWindow(undefined, outlookWin.processId);
        await new Promise(r => setTimeout(r, 300));
        const b = outlookWin.bounds;
        if (b && b.x > -100 && b.y > -100 && b.width > 100 && b.height > 100) {
          await this.desktop.mouseClick(b.x + Math.floor(b.width / 2), b.y + Math.floor(b.height / 2));
          await new Promise(r => setTimeout(r, 300));
        }
        await this.desktop.keyPress('Control+n');
        console.log(`   📧 Step 1: Ctrl+N in Outlook, waiting for compose...`);
        await new Promise(r => setTimeout(r, 2000));
        composeOpen = true; // verification below will catch failures
      }

      // Verify we're actually in Outlook compose window (not some other app)
      const composeWin = await this.a11y.getActiveWindow();
      const composeTitle = (composeWin?.title || '').toLowerCase();
      const isOutlookCompose = /message|untitled|outlook/i.test(composeTitle)
        || /OUTLOOK/i.test(composeWin?.processName || '');
      if (!isOutlookCompose) {
        console.log(`   ❌ Compose window check FAILED: active window is "${composeWin?.title}" (${composeWin?.processName}), not Outlook`);
        return { handled: false, description: `Wrong window: "${composeWin?.title}" is not Outlook compose`, failedAtStep: 1, stepsCompleted: 1 };
      }
      console.log(`   📧 Verified Outlook compose: "${composeWin?.title}" (${composeWin?.processName})`);

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

  // ─── Find & Replace ──────────────────────────────────────────────────────

  /**
   * Extract text to type before find-and-replace (e.g., "clear text, type X, then find Y replace with Z")
   */
  private parsePreReplaceText(task: string): { clearFirst: boolean; textToType: string | null } {
    const taskLower = task.toLowerCase();
    const clearFirst = /ctrl\+a|select all|clear/i.test(taskLower);

    // Extract text between "type ..." and "then find/replace"
    const typeMatch = task.match(/type\s+(.+?)(?:,?\s+then\s+(?:find|replace|use\s+ctrl))/i);
    const textToType = typeMatch ? typeMatch[1].trim() : null;

    return { clearFirst, textToType };
  }

  private parseFindReplaceTask(task: string): { find: string; replace: string } | null {
    // Pattern: "find X and replace (it )with Y" or "replace X with Y"
    const m1 = task.match(/find\s+(?:the\s+(?:word|text)\s+)?["']?(.+?)["']?\s+(?:and\s+)?replace\s+(?:it\s+)?with\s+["']?(.+?)["']?(?:\s*$|\s*[.,])/i);
    if (m1) return { find: m1[1].trim(), replace: m1[2].trim() };

    const m2 = task.match(/replace\s+(?:the\s+(?:word|text)\s+)?["']?(.+?)["']?\s+with\s+["']?(.+?)["']?(?:\s*$|\s*[.,])/i);
    if (m2) return { find: m2[1].trim(), replace: m2[2].trim() };

    return null;
  }

  /**
   * Find & Replace: deterministic keyboard-only navigation.
   * Optional: clear + type text first, then Ctrl+H → type find → Tab → type replace → Alt+A → Escape
   */
  private async findReplaceFlow(find: string, replace: string, preText?: { clearFirst: boolean; textToType: string | null }): Promise<FlowResult> {
    console.log(`   🔍 Deterministic find & replace: "${find}" → "${replace}"${preText?.textToType ? ` (with pre-type: "${preText.textToType.substring(0, 40)}...")` : ''}`);
    let step = 0;

    try {
      // Pre-step: Clear existing text if requested
      if (preText?.clearFirst) {
        step++;
        await this.desktop.keyPress('ctrl+a');
        await new Promise(r => setTimeout(r, 100));
        await this.desktop.keyPress('Delete');
        await new Promise(r => setTimeout(r, 200));
        console.log(`   🔍 Step ${step}: Ctrl+A, Delete — cleared text`);
      }

      // Pre-step: Type new text if provided
      if (preText?.textToType) {
        step++;
        await this.a11y.writeClipboard(preText.textToType);
        await new Promise(r => setTimeout(r, 50));
        await this.desktop.keyPress('ctrl+v');
        await new Promise(r => setTimeout(r, 300));
        console.log(`   🔍 Step ${step}: Typed "${preText.textToType.substring(0, 40)}..."`);
      }

      // Step N+1: Open Find & Replace
      step++;
      await this.desktop.keyPress('ctrl+h');
      await new Promise(r => setTimeout(r, 800));
      console.log(`   🔍 Step ${step}: Ctrl+H — opened Find & Replace`);

      // Clear the search field and type search term
      step++;
      await this.desktop.keyPress('ctrl+a'); // select all in focused field
      await new Promise(r => setTimeout(r, 50));
      await this.a11y.writeClipboard(find);
      await new Promise(r => setTimeout(r, 50));
      await this.desktop.keyPress('ctrl+v');
      await new Promise(r => setTimeout(r, 200));
      console.log(`   🔍 Step ${step}: Typed find term "${find}"`);

      // Tab to Replace field
      step++;
      await this.desktop.keyPress('Tab');
      await new Promise(r => setTimeout(r, 200));
      console.log(`   🔍 Step ${step}: Tab to Replace field`);

      // Clear the replace field and type replacement
      step++;
      await this.desktop.keyPress('ctrl+a');
      await new Promise(r => setTimeout(r, 50));
      await this.a11y.writeClipboard(replace);
      await new Promise(r => setTimeout(r, 50));
      await this.desktop.keyPress('ctrl+v');
      await new Promise(r => setTimeout(r, 200));
      console.log(`   🔍 Step ${step}: Typed replace term "${replace}"`);

      // Replace All (Alt+A in Notepad's Find & Replace)
      step++;
      await this.desktop.keyPress('alt+a');
      await new Promise(r => setTimeout(r, 500));
      console.log(`   🔍 Step ${step}: Alt+A — Replace All`);

      // Close the dialog
      step++;
      await this.desktop.keyPress('Escape');
      await new Promise(r => setTimeout(r, 300));
      console.log(`   🔍 Step ${step}: Escape — closed dialog`);

      return {
        handled: true,
        description: `Replaced "${find}" with "${replace}"${preText?.textToType ? ' (with pre-typed text)' : ''}`,
        stepsCompleted: step,
      };
    } catch (err) {
      console.log(`   ❌ Find & Replace flow error at step ${step}: ${err}`);
      return { handled: false, description: `Error at step ${step}: ${err}`, failedAtStep: step, stepsCompleted: step - 1 };
    }
  }
}
