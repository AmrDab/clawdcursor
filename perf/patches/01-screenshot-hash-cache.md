# Patch 01: Screenshot Hash Cache

**File:** `src/ai-brain.ts`

## Add import

```typescript
// Add at top of file
import * as crypto from 'crypto';
```

## Add cache fields to AIBrain class

```typescript
// Add after maxHistoryTurns field
private lastScreenshotHash: string = '';
private lastDecisionCache: {
  action: InputAction | null;
  sequence: ActionSequence | null;
  description: string;
  done: boolean;
  error?: string;
  waitMs?: number;
} | null = null;
```

## Add hash check at top of decideNextAction()

Insert before `const base64Image = screenshot.buffer.toString('base64');`:

```typescript
// Sample 1KB evenly spaced from buffer for fast comparison
const sampleSize = Math.min(1024, screenshot.buffer.length);
const step = Math.max(1, Math.floor(screenshot.buffer.length / sampleSize));
const sample = Buffer.alloc(sampleSize);
for (let i = 0; i < sampleSize; i++) {
  sample[i] = screenshot.buffer[i * step];
}
const hash = crypto.createHash('md5').update(sample).digest('hex');

if (hash === this.lastScreenshotHash && this.lastDecisionCache && !this.lastDecisionCache.done) {
  console.log('   ⚡ Screenshot unchanged — using cached LLM decision');
  return this.lastDecisionCache;
}
this.lastScreenshotHash = hash;
```

## Cache result before return

Replace `return this.parseResponse(response, scale);` with:

```typescript
const result = this.parseResponse(response, scale);
this.lastDecisionCache = result;
return result;
```

## Clear cache on reset

```typescript
resetConversation(): void {
  this.history = [];
  this.lastScreenshotHash = '';
  this.lastDecisionCache = null;
}
```
