#!/bin/bash
# Test loop: send email task, 60s timeout, inspect logs after each
RESULTS_DIR="$HOME/.clawd-cursor/test-results"
mkdir -p "$RESULTS_DIR"
TASK='open outlook and send an email to test@hotmail.com saying hello'
TIMEOUT=60
TOTAL=10
LOGFILE=$(ls -t /c/Users/amr_d/AppData/Local/Temp/claude/C--Users-amr-d/tasks/*.output 2>/dev/null | head -1)

echo "=== Test Loop: $TOTAL iterations, ${TIMEOUT}s timeout ===" | tee "$RESULTS_DIR/summary.txt"
echo "Agent log: $LOGFILE"
echo ""

for i in $(seq 1 $TOTAL); do
  echo "──── TEST $i/$TOTAL — $(date +%H:%M:%S) ────"

  # Make sure agent is idle — abort + wait
  curl -s -X POST http://127.0.0.1:3847/abort > /dev/null 2>&1
  sleep 2

  # Verify idle
  for retry in 1 2 3 4 5; do
    STATUS=$(curl -s http://127.0.0.1:3847/status 2>/dev/null)
    IS_IDLE=$(echo "$STATUS" | grep -o '"status":"idle"')
    if [ -n "$IS_IDLE" ]; then
      break
    fi
    echo "  Waiting for idle (attempt $retry)..."
    curl -s -X POST http://127.0.0.1:3847/abort > /dev/null 2>&1
    sleep 3
  done

  if [ -z "$IS_IDLE" ]; then
    echo "  Agent stuck — skipping"
    echo "TEST $i: SKIP (agent stuck)" >> "$RESULTS_DIR/summary.txt"
    continue
  fi

  # Record log position before test
  LOG_LINES_BEFORE=0
  if [ -n "$LOGFILE" ] && [ -f "$LOGFILE" ]; then
    LOG_LINES_BEFORE=$(wc -l < "$LOGFILE")
  fi

  # Send task
  RESPONSE=$(curl -s -X POST http://127.0.0.1:3847/task \
    -H "Content-Type: application/json" \
    -d "{\"task\": \"$TASK\"}")

  ACCEPTED=$(echo "$RESPONSE" | grep -o '"accepted":true')
  if [ -z "$ACCEPTED" ]; then
    echo "  NOT ACCEPTED: $RESPONSE"
    echo "TEST $i: SKIP (not accepted)" >> "$RESULTS_DIR/summary.txt"
    sleep 2
    continue
  fi

  # Poll for completion
  START_TIME=$(date +%s)
  RESULT="TIMEOUT"

  while true; do
    sleep 3
    ELAPSED=$(( $(date +%s) - START_TIME ))

    STATUS=$(curl -s http://127.0.0.1:3847/status 2>/dev/null)
    AGENT_STATUS=$(echo "$STATUS" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ "$AGENT_STATUS" = "idle" ] && [ $ELAPSED -gt 5 ]; then
      RESULT="COMPLETED"
      break
    fi

    if [ $ELAPSED -ge $TIMEOUT ]; then
      curl -s -X POST http://127.0.0.1:3847/abort > /dev/null 2>&1
      RESULT="TIMEOUT"
      sleep 3
      break
    fi
  done

  DURATION=$(( $(date +%s) - START_TIME ))

  # Extract this test's logs
  if [ -n "$LOGFILE" ] && [ -f "$LOGFILE" ]; then
    tail -n +$((LOG_LINES_BEFORE + 1)) "$LOGFILE" > "$RESULTS_DIR/test${i}.log" 2>/dev/null
    # Check for success/failure in log
    HAS_SUCCESS=$(grep -c "SUCCESS" "$RESULTS_DIR/test${i}.log" 2>/dev/null || echo 0)
    HAS_FAILED=$(grep -c "FAILED" "$RESULTS_DIR/test${i}.log" 2>/dev/null || echo 0)
    if [ "$HAS_SUCCESS" -gt 0 ]; then
      RESULT="SUCCESS"
    elif [ "$HAS_FAILED" -gt 0 ] && [ "$RESULT" != "TIMEOUT" ]; then
      RESULT="FAILED"
    fi
  fi

  echo "  => $RESULT (${DURATION}s)"
  echo "TEST $i: $RESULT (${DURATION}s)" >> "$RESULTS_DIR/summary.txt"

  # Print key lines from this test's log
  if [ -f "$RESULTS_DIR/test${i}.log" ]; then
    echo "  --- Key log lines ---"
    grep -E "Layer [23]|Subtask|SUCCESS|FAILED|TIMEOUT|stuck|error|visual hint|Clicked|max steps" "$RESULTS_DIR/test${i}.log" | tail -15
    echo "  ---"
  fi

  echo ""
  sleep 2
done

echo ""
echo "========== SUMMARY =========="
cat "$RESULTS_DIR/summary.txt"
