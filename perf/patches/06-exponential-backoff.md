# Patch 06: Exponential Backoff with Jitter

**File:** `src/ai-brain.ts`

## Replace linear backoff in callLLMText()

**Before:**
```typescript
const backoff = 1000 * (attempt + 1);
```

**After:**
```typescript
const backoff = Math.min(1000 * Math.pow(2, attempt), 8000) + Math.random() * 1000;
```
