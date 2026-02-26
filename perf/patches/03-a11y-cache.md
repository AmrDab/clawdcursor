# Patch 03: A11y Context Cache (500ms TTL)

**File:** `src/accessibility.ts`

## Add cache interface and fields

```typescript
interface ScreenContextCache {
  context: string;
  timestamp: number;
}

// In AccessibilityBridge class:
private screenContextCache: ScreenContextCache | null = null;
private readonly SCREEN_CONTEXT_CACHE_TTL = 500;
```

## Add cache check at top of getScreenContext()

```typescript
if (
  !focusedProcessId &&
  this.screenContextCache &&
  Date.now() - this.screenContextCache.timestamp < this.SCREEN_CONTEXT_CACHE_TTL
) {
  return this.screenContextCache.context;
}
```

## Cache before return

```typescript
if (!focusedProcessId) {
  this.screenContextCache = { context, timestamp: Date.now() };
}
return context;
```

## Invalidate on window changes

```typescript
invalidateCache(): void {
  this.windowCache = null;
  this.screenContextCache = null;
}
```
