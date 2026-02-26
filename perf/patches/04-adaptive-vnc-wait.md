# Patch 04: Adaptive VNC Frame Wait

**File:** `src/vnc-client.ts`

## Add tracking field

```typescript
private pendingRectReceived = false;
```

## Set flag in rect handler

```typescript
this.client.on('rect', (rect: any) => {
  this.pendingRectReceived = true;
  // ... existing rect processing
});
```

## Add waitForFrameUpdate method

```typescript
private async waitForFrameUpdate(maxWaitMs = 800): Promise<void> {
  this.pendingRectReceived = false;
  const start = Date.now();
  const minWaitMs = 100;

  await this.delay(minWaitMs);

  while (!this.pendingRectReceived && Date.now() - start < maxWaitMs) {
    await this.delay(50);
  }

  if (this.pendingRectReceived) {
    await this.delay(50); // trailing rect wait
  }
}
```

## Replace fixed delays

Replace both `await this.delay(800);` in `captureScreen()` and `captureForLLM()` with:

```typescript
await this.waitForFrameUpdate();
```
