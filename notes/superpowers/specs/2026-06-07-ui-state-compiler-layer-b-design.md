# UI State Compiler — Layer B Design (semantic finders)

**Date:** 2026-06-07
**Status:** Approved (design); implementation not started
**Branch:** `v1.5.0`
**Builds on:** Layer A core + Part 2 (`src/core/sense/ui-map*.ts`, `compile_ui`,
el_NN ref actions, `UIMapHolder`) — see the Layer A and Part 2 specs.

---

## 1. Context & scope

Layer A compiles the screen into a `UIMap`; Part 2 wired it in and made acting
on a compiled element (`el_NN`) safe (`invoke_element`/`set_field_value` with
`{element_id, snapshot_id}`, holder-resolved, staleness-guarded). Layer B adds
the missing **semantic resolution** layer: turn an *intent* into the right
`el_NN`, app-agnostically.

The original Layer B list is mostly already shipped: `click_element`/`fill_input`
= the Part-2 ref actions; `verify_state` = the `verify` tool. So Layer B reduces
to the genuinely missing piece — the **semantic finders**.

**In scope:** `find_action_button(intent)` and `find_input_field(purpose)` —
deterministic intent→element matchers over the UIMap, returning a ref the
agent acts on via the Part-2 path.

**Out of scope (deferred):** find-and-act combinators, `request_approval`/HITL,
Layer C intent flows, vision-element fusion.

**Hard constraint:** OS-agnostic. The matcher is pure TypeScript over
`UIElement[]` — zero `process.platform` branching; all OS specifics stay in the
already-OS-agnostic compiler below it.

**Approved decisions (brainstorming):**

| Decision | Choice |
|---|---|
| Scope | semantic finders only (no combinators, no HITL) |
| Matcher | self-text + curated synonyms + geometric label association (left/above, a11y OR OCR) |
| Map source | default `max_cost:'ocr_ok'`; respect explicit `cheap`; reuse fresh current map only if compiled at cost ≥ requested (correctness first, cost-reuse second) |
| Result | tri-state `ok`/`ambiguous`/`none`; single `best` when confident; candidates always included |

---

## 2. Result contract

```ts
interface FindCandidate {
  element_id: string;
  label: string;        // the text/label the match scored against
  role: Role;
  score: number;        // 0..1 match strength (synonym/fuzzy × confidence)
  confidence: number;   // the element's UIMap confidence
}

type FindResult =
  | { status: 'ok'; snapshot_id: string; best: FindCandidate; candidates: FindCandidate[] }
  | { status: 'ambiguous'; snapshot_id: string; reason: string; candidates: FindCandidate[] }
  | { status: 'none'; snapshot_id: string; reason: string; candidates: FindCandidate[] };
```

- `ok` — a clear winner: `best.score >= MATCH_THRESHOLD` AND (no runner-up OR
  `best.score - second.score >= AMBIGUITY_MARGIN`). The agent acts on
  `{snapshot_id, best.element_id}` directly.
- `ambiguous` — `best.score >= MATCH_THRESHOLD` but the top two are within
  `AMBIGUITY_MARGIN` — the finder refuses to pretend certainty; the agent picks
  from `candidates` (e.g. by reading the render) or re-queries.
- `none` — nothing clears `MATCH_THRESHOLD`; `candidates` carries the top few
  raw matches for context so the agent can re-phrase or fall back.
- `snapshot_id` is always the **current, resolvable** map's id (so any
  `candidates[i].element_id` the agent chooses is actionable via the ref path).
- `candidates` is the top ~5 by score, always present.

Constants: `MATCH_THRESHOLD = 0.4` (min to count as a match — aligns with the
existing smart-match floor), `AMBIGUITY_MARGIN = 0.05` (top-two closeness),
`MAX_CANDIDATES = 5`.

The MCP tool returns this object as JSON in `text` (mirrors `ocr_read_screen`),
so external agents parse it; the in-loop agent reads the same.

---

## 3. Pure matcher (`src/core/sense/ui-map-find.ts`, OS-agnostic)

Two exported pure functions over a compiled element list:

```ts
findActionButton(elements: UIElement[], snapshotId: string, intent: string): FindResult
findInputField(elements: UIElement[], snapshotId: string, purpose: string): FindResult
```

### 3a. Synonym expansion
A curated `INTENT_SYNONYMS` map (extends the existing `PRIMARY_VERBS`):

- **Action intents:** `submit`→{submit,send,ok,confirm,save,continue,next,post,
  publish,apply,done,go}; `cancel`→{cancel,close,dismiss,back,no}; `delete`→
  {delete,remove,trash,discard}; `search`→{search,find,go,query}; `login`→
  {login,log in,sign in,signin}; `open`→{open,launch,view}; `add`→{add,new,create,
  plus}. (Extensible map; unknown intents fall back to literal matching.)
- **Field purposes:** `recipient`→{to,recipient,email,address,send to}; `cc`→
  {cc,carbon copy}; `subject`→{subject,title,re}; `body`→{body,message,content,
  compose,note}; `search`→{search,query,find,filter}; `password`→{password,pass,
  pwd}; `username`→{username,user,login,email}; `name`→{name,full name}.

The literal `intent`/`purpose` text (normalized) is ALWAYS also a match term.

### 3b. Candidate label
- `find_action_button`: candidates = elements with `clickable === true`. Label =
  the element's own `normalized_text`.
- `find_input_field`: candidates = elements with `editable === true`. Label =
  the element's own `normalized_text`; **if empty**, the geometrically
  associated label (§3d).

### 3c. Scoring
For a candidate label `L` and the expanded term set `T` (synonyms + literal):
- exact (`L === t` for some `t∈T`) → `1.0`
- whole-word/synonym contained (`L` contains `t` as a token, or `t` contains `L`)
  → `0.9`
- token overlap → `0.5 × (overlap / |intent tokens|)`
- else → `0`

`score = rawMatch × element.confidence` (so a high-text-match on a
low-confidence element doesn't outrank a solid one). Rank desc; build the
tri-state result per §2.

### 3d. Geometric label association (fields, OS-agnostic)
When an `editable` element has empty own-text, find its label among ALL elements
(role `text`/`unknown`/`link`, any source — a11y OR OCR):
- **left, same row:** a text element whose vertical center is within the field's
  y-band and whose right edge is just left of the field's left edge, nearest by
  x-gap (within `MAX_LABEL_GAP_X`).
- **above, same column:** a text element horizontally overlapping the field whose
  bottom edge is just above the field's top, nearest by y-gap (within
  `MAX_LABEL_GAP_Y`).
- Prefer left over above when both exist within bounds. The chosen text becomes
  the field's label for scoring. Pure geometry over `UIElement.bounds` — no OS
  or app specifics. Constants `MAX_LABEL_GAP_X`/`MAX_LABEL_GAP_Y` are tunable
  (start ~ a few × the field height / a row height).

---

## 4. The finder tools + map-source policy

`find_action_button` / `find_input_field` are System B tools (in
`agent-loop/tools.ts`), projected to the MCP surface. Each:

1. `requested = args.max_cost ?? 'ocr_ok'`.
2. **Map source (correctness first, cost-reuse second):** if the holder has a
   fresh current map (`resolve` ok) compiled at a cost `>=` `requested`, reuse
   it. Otherwise mint `nextId()`, `compileUIMap(defaultCompileDeps(platform,
   now, id), { max_cost: requested })`, `holder.put(map, now, requested)`.
3. Run the pure finder on `map.elements` + `map.snapshot_id`.
4. Return the `FindResult` JSON.

`changesScreen: false`; `costClass: perceive-text` (may pull OCR per lazy
policy); safety tier `read`; wired into `tool-meta`/`cost-class`/`safety`/
`registry`; schema-snapshot regenerated.

### Holder extension (small, backward-compatible)
`UIMapHolder.put(map, now, maxCost?)` records the compiled `max_cost` per entry.
New helper `currentIfCost(requested, now): UIMap | null` returns the current map
iff it resolves (fresh/in-TTL/not-invalidated) AND its stored `maxCost` rank
`>= requested` rank (`cheap < ocr_ok < vision_ok`). Existing `put` callers
(compile_ui tool, the loop's `storeUIMap`) pass their `max_cost` (`compile_ui`'s
effective hint; the loop's `'cheap'`); callers that omit it record `undefined`,
which `currentIfCost` treats as not-satisfying any `ocr_ok`+ request (→ compile
fresh — the safe default).

---

## 5. Testing

**Pure matcher** (no platform): intent "submit" → "Send" button (synonym);
literal/fuzzy match; role filter (button query ignores editable-only elements
and vice-versa); `find_input_field("recipient")` matches a label-less "To" Edit
via a LEFT a11y label; via an ABOVE label; via an OCR-sourced label (WebView
case); ambiguity (two equal-score buttons → `status:'ambiguous'`, `best` absent);
none (no match → `status:'none'` + candidates); `score = match × confidence`
ordering; candidates capped at `MAX_CANDIDATES`.

**Holder extension:** `currentIfCost` reuses a fresh `ocr_ok` map for an
`ocr_ok` request; refuses a `cheap`-compiled map for an `ocr_ok` request;
refuses a stale/expired map; treats `undefined` recorded cost as not-satisfying.

**Tools:** find tool compiles (or reuses) and returns a `snapshot_id` that
`resolveRef` accepts (find→act chain coherent); `max_cost:'cheap'` forbids OCR;
result is valid JSON of the `FindResult` shape.

**Gate:** `tsc` src+tests, full `vitest`, `eslint` 0 errors, schema-snapshot
regenerated + committed.

---

## 6. Files

- **New:** `src/core/sense/ui-map-find.ts` (matcher: synonyms, scoring, label
  association) + `src/__tests__/ui-map-find.test.ts`; finder tools added to
  `src/core/agent-loop/tools.ts` + `src/__tests__/ui-map-find-tools.test.ts`.
- **Modify:** `src/core/sense/ui-map-holder.ts` (`put` maxCost + `currentIfCost`)
  + its test; `compile_ui` tool + loop `storeUIMap` (pass `max_cost` to `put`);
  `tool-meta.ts`/`cost-class.ts`/`core/safety.ts`/`tools/registry.ts` (finder
  wiring); `schema.snapshot.json` (regen).
- **Reused:** `compileUIMap`, `defaultCompileDeps`, `UIMapHolder`, `normText`,
  the `PRIMARY_VERBS` seed, the Part-2 ref actions (agent acts on the result).

## 7. Scope fence

- ❌ find-and-act combinators (finders return refs; agent acts via Part-2 path).
- ❌ `request_approval` / HITL.
- ❌ Layer C intent flows; ❌ vision-element fusion.
- ❌ no LLM in the matcher (deterministic synonyms + geometry + confidence only).
- ❌ no `process.platform` branching anywhere in Layer B.
- ❌ no app-specific knowledge — generic semantic resolution over the UIMap.
