# Patch 02: Parallel Screenshot + A11y Fetch

**File:** `src/agent.ts`

## Add import

```typescript
import { writeFile } from 'fs/promises';
```

## Replace sequential fetch in executeLLMFallback()

**Before:**
```typescript
const screenshot = await this.vnc.captureForLLM();
// ... debug write ...
let a11yContext: string | undefined;
try {
  a11yContext = await this.a11y.getScreenContext();
} catch { }
```

**After:**
```typescript
const [screenshot, a11yContext] = await Promise.all([
  this.vnc.captureForLLM(),
  this.a11y.getScreenContext().catch(() => undefined as string | undefined),
]);
```
