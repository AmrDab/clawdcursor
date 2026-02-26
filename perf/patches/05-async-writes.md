# Patch 05: Async Debug Writes

**File:** `src/agent.ts`

## Replace sync write

**Before:**
```typescript
fs.writeFileSync(
  path.join(debugDir, `subtask-${subtaskIndex}-step-${j}.${ext}`),
  screenshot.buffer,
);
```

**After:**
```typescript
writeFile(
  path.join(debugDir, `subtask-${subtaskIndex}-step-${j}.${ext}`),
  screenshot.buffer,
).catch(() => {});
```
