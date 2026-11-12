# Anonymous error reports

clawdcursor sends anonymous error reports so that bugs can be found and fixed. They are on by default. The first time it
starts, clawdcursor says so in one line on stderr.

`clawdcursor telemetry` shows whether they are on and lists every field that is sent.

## What is sent

Every field is a number or a value from a fixed list. Tool and action names are clawdcursor's own.

| Event | When | Fields |
|---|---|---|
| `start` | the MCP server starts | OS family and major version, CPU architecture, Node major version, host app (from a fixed list, else `other`), compact or granular surface |
| `call_failed` | a tool call fails, times out or reads nothing | tool, action, result code (`NOT_FOUND`, `TIMEOUT`, ...), outcome, duration, app kind (`browser`, `electron`, `native`, `unknown`) |
| `slow_call` | a tool call takes more than 10 s | tool, action, duration, its slow internal steps (clawdcursor's helper programs, by name, and their ms) |
| `exit` | the server exits during a call, or was killed or crashed | reason class (`sigterm`, `host_gone`, ...), the tool and action that were cut off, how long they had run |
| `crash` | an uncaught error | error class (`TypeError`, ...), error code (`ENOENT`, ...), stack frames reduced to clawdcursor's own `file:line` |

Every event also carries the clawdcursor version, the OS family and a random install id. The id is made on your machine and
is not derived from your hardware or accounts.

## What is never sent

Error messages, typed text, clipboard contents, screen or OCR text, screenshots, window titles, app names, URLs, element
names, file paths outside clawdcursor, user names, emails and IP addresses. The detailed logs stay on your machine
(`~/.clawdcursor/logs`).

## Turning it off

Any one of these turns it off:

- `clawdcursor optout` (`clawdcursor optin` turns it back on)
- ask your agent: it calls `system {action:"telemetry_optout"}` (agents can only turn it off, never on)
- `CLAWD_TELEMETRY=0` or `DO_NOT_TRACK=1` in the environment

It is always off in CI and in test runs. The setting is kept in `~/.clawdcursor/telemetry.json`.

## Where it goes

Reports go over HTTPS to a Cloudflare Worker run by the clawdcursor project. It checks every event against the same fixed
lists and drops anything else. It does not read or store your IP address or request headers, and deletes events after 90 days.
Its code is in [`telemetry-worker/`](https://github.com/AmrDab/clawdcursor/tree/main/telemetry-worker).
