/**
 * Agent — the main orchestration loop.
 * Now supports action sequences (multi-step without re-screenshotting).
 */

import * as fs from 'fs';
import * as path from 'path';
import { VNCClient } from './vnc-client';
import { AIBrain } from './ai-brain';
import { SafetyLayer } from './safety';
import { SafetyTier } from './types';
import type { ClawdConfig, AgentState, TaskResult, StepResult, InputAction, ActionSequence } from './types';

const MAX_STEPS = 15;
const MAX_SIMILAR_ACTION = 3;

export class Agent {
  private vnc: VNCClient;
  private brain: AIBrain;
  private safety: SafetyLayer;
  private config: ClawdConfig;
  private state: AgentState = {
    status: 'idle',
    stepsCompleted: 0,
    stepsTotal: 0,
  };
  private aborted = false;

  constructor(config: ClawdConfig) {
    this.config = config;
    this.vnc = new VNCClient(config);
    this.brain = new AIBrain(config);
    this.safety = new SafetyLayer(config);
  }

  async connect(): Promise<void> {
    await this.vnc.connect();
    const size = this.vnc.getScreenSize();
    this.brain.setScreenSize(size.width, size.height);
  }

  async executeTask(task: string): Promise<TaskResult> {
    this.aborted = false;
    this.state = {
      status: 'thinking',
      currentTask: task,
      stepsCompleted: 0,
      stepsTotal: MAX_STEPS,
    };

    const steps: StepResult[] = [];
    const stepDescriptions: string[] = [];
    const startTime = Date.now();
    const recentActions: string[] = [];

    console.log(`\n🐾 Starting task: ${task}`);

    // Debug directory — clean old screenshots on each new task
    const debugDir = path.join(process.cwd(), 'debug');
    if (fs.existsSync(debugDir)) {
      for (const f of fs.readdirSync(debugDir)) fs.unlinkSync(path.join(debugDir, f));
    } else {
      fs.mkdirSync(debugDir);
    }

    // Initial screenshot
    let lastScreenshot = await this.vnc.captureScreen();
    console.log(`   Screen: ${lastScreenshot.width}x${lastScreenshot.height}`);
    console.log(`   Screenshot size: ${(lastScreenshot.buffer.length / 1024).toFixed(0)}KB`);
    
    // Save debug screenshot
    const ext = lastScreenshot.format === 'jpeg' ? 'jpg' : 'png';
    fs.writeFileSync(path.join(debugDir, `step-0.${ext}`), lastScreenshot.buffer);
    console.log(`   💾 Saved debug/step-0.${ext}`);

    for (let i = 0; i < MAX_STEPS; i++) {
      if (this.aborted) {
        console.log('⛔ Task aborted by user');
        break;
      }

      // Capture screen (skip first iteration — already have initial screenshot)
      if (i > 0) {
        console.log(`\n📸 Step ${i + 1}: Capturing screen...`);
        await this.delay(1000);
        lastScreenshot = await this.vnc.captureScreen();
        fs.writeFileSync(path.join(debugDir, `step-${i}.${ext}`), lastScreenshot.buffer);
        console.log(`   💾 Saved debug/step-${i}.${ext} (${(lastScreenshot.buffer.length / 1024).toFixed(0)}KB)`);
      } else {
        console.log(`\n📸 Step 1: Using initial screenshot`);
      }

      // Ask AI what to do
      this.state.status = 'thinking';
      const decision = await this.brain.decideNextAction(lastScreenshot, task, stepDescriptions);

      // Done?
      if (decision.done) {
        console.log(`✅ Task complete: ${decision.description}`);
        steps.push({ action: 'done', description: decision.description, success: true, timestamp: Date.now() });
        break;
      }

      // Error?
      if (decision.error) {
        console.log(`❌ Error: ${decision.error}`);
        steps.push({ action: 'error', description: decision.error, success: false, timestamp: Date.now() });
        break;
      }

      // Wait?
      if (decision.waitMs) {
        console.log(`⏳ Waiting ${decision.waitMs}ms: ${decision.description}`);
        await this.delay(decision.waitMs);
        stepDescriptions.push(decision.description);
        continue;
      }

      // Handle SEQUENCE
      if (decision.sequence) {
        console.log(`📋 Sequence: ${decision.sequence.description} (${decision.sequence.steps.length} steps)`);
        
        for (const seqStep of decision.sequence.steps) {
          if (this.aborted) break;

          const tier = this.safety.classify(seqStep, seqStep.description);
          console.log(`  ${tierEmoji(tier)} ${seqStep.description}`);

          // If confirm tier, pause the sequence
          if (tier === SafetyTier.Confirm) {
            this.state.status = 'waiting_confirm';
            const approved = await this.safety.requestConfirmation(seqStep, seqStep.description);
            if (!approved) {
              console.log(`  ❌ User rejected — stopping sequence`);
              steps.push({ action: 'rejected', description: `USER REJECTED: ${seqStep.description}`, success: false, timestamp: Date.now() });
              break;
            }
          }

          // Execute the step
          try {
            if ('x' in seqStep) {
              await this.vnc.executeMouseAction(seqStep);
            } else {
              await this.vnc.executeKeyboardAction(seqStep);
            }
            steps.push({ action: seqStep.kind, description: seqStep.description, success: true, timestamp: Date.now() });
            stepDescriptions.push(seqStep.description);
            await this.delay(200); // Brief pause between sequence steps
          } catch (err) {
            console.error(`  Failed:`, err);
            steps.push({ action: seqStep.kind, description: `FAILED: ${seqStep.description}`, success: false, error: String(err), timestamp: Date.now() });
          }
        }

        this.state.stepsCompleted = i + 1;
        continue; // Take a new screenshot after sequence
      }

      // Handle SINGLE ACTION
      if (decision.action) {
        // Duplicate detection
        const actionKey = decision.action.kind + ('x' in decision.action ? `@${decision.action.x},${decision.action.y}` : ('key' in decision.action ? `@${(decision.action as any).key}` : ''));
        recentActions.push(actionKey);
        const lastN = recentActions.slice(-MAX_SIMILAR_ACTION);
        if (lastN.length >= MAX_SIMILAR_ACTION && lastN.every(a => a === lastN[0])) {
          console.log(`🔄 Same action repeated ${MAX_SIMILAR_ACTION} times — aborting`);
          steps.push({ action: 'stuck', description: `Stuck: repeated "${actionKey}"`, success: false, timestamp: Date.now() });
          break;
        }

        // Safety check
        const tier = this.safety.classify(decision.action, decision.description);
        console.log(`${tierEmoji(tier)} Action: ${decision.description}`);

        if (this.safety.isBlocked(decision.description)) {
          console.log(`🚫 BLOCKED: ${decision.description}`);
          steps.push({ action: 'blocked', description: `BLOCKED: ${decision.description}`, success: false, timestamp: Date.now() });
          break;
        }

        if (tier === SafetyTier.Confirm) {
          this.state.status = 'waiting_confirm';
          this.state.currentStep = `Confirm: ${decision.description}`;
          const approved = await this.safety.requestConfirmation(decision.action, decision.description);
          if (!approved) {
            console.log(`❌ User rejected`);
            steps.push({ action: 'rejected', description: `USER REJECTED: ${decision.description}`, success: false, timestamp: Date.now() });
            continue;
          }
        }

        // Execute
        this.state.status = 'acting';
        this.state.currentStep = decision.description;

        try {
          if ('x' in decision.action) {
            await this.vnc.executeMouseAction(decision.action);
          } else {
            await this.vnc.executeKeyboardAction(decision.action);
          }
          steps.push({ action: decision.action.kind, description: decision.description, success: true, timestamp: Date.now() });
          stepDescriptions.push(decision.description);
          this.state.stepsCompleted = i + 1;
        } catch (err) {
          console.error(`Failed:`, err);
          steps.push({ action: decision.action.kind, description: `FAILED: ${decision.description}`, success: false, error: String(err), timestamp: Date.now() });
        }
      }
    }

    this.state.status = 'idle';
    this.state.currentTask = undefined;
    this.brain.resetConversation();

    const result: TaskResult = {
      success: steps.length > 0 && steps[steps.length - 1]?.success === true,
      steps,
      duration: Date.now() - startTime,
    };

    console.log(`\n⏱️  Task took ${(result.duration / 1000).toFixed(1)}s with ${steps.length} steps`);
    return result;
  }

  abort(): void {
    this.aborted = true;
  }

  getState(): AgentState {
    return { ...this.state };
  }

  getSafety(): SafetyLayer {
    return this.safety;
  }

  disconnect(): void {
    this.vnc.disconnect();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function tierEmoji(tier: SafetyTier): string {
  switch (tier) {
    case SafetyTier.Auto: return '🟢';
    case SafetyTier.Preview: return '🟡';
    case SafetyTier.Confirm: return '🔴';
  }
}
