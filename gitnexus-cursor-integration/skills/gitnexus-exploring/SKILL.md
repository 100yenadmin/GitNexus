---
name: gitnexus-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
---

# Exploring Codebases with GitNexus

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

```
1. READ gitnexus://repos                          → Discover indexed repos
2. READ gitnexus://repo/{name}/context             → Codebase overview, check staleness
3. Pin repo, absolute worktree, worktree HEAD, and index commit
4. query({search_query: "<what you want to understand>", repo: "<repo>"})
5. context({name: "<symbol>", repo: "<repo>"})
6. READ gitnexus://repo/{name}/process/{name}      → Trace full execution flow
```

If step 2 says the index is stale, label graph evidence stale. Reindexing writes
repository and registry state; run it only with authority.

## Checklist

```
- [ ] READ gitnexus://repo/{name}/context
- [ ] Record the exact repo, worktree HEAD, and index commit
- [ ] Pass repo on every query/context call
- [ ] Review returned processes (execution flows)
- [ ] context on key symbols for callers/callees
- [ ] READ process resource for full execution traces
- [ ] Read source files for implementation details
```

## Resources

| Resource                                | What you get                                            |
| --------------------------------------- | ------------------------------------------------------- |
| `gitnexus://repo/{name}/context`        | Stats, staleness warning (~150 tokens)                  |
| `gitnexus://repo/{name}/clusters`       | All functional areas with cohesion scores (~300 tokens) |
| `gitnexus://repo/{name}/cluster/{name}` | Area members with file paths (~500 tokens)              |
| `gitnexus://repo/{name}/process/{name}` | Step-by-step execution trace (~200 tokens)              |

## Tools

**query** — find execution flows related to a concept:

```
query({search_query: "payment processing", repo: "my-app"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**context** — 360-degree view of a symbol:

```
context({name: "validateUser", repo: "my-app"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

## Example: "How does payment processing work?"

```
1. READ gitnexus://repo/my-app/context       → 918 symbols, 45 processes
2. query({search_query: "payment processing", repo: "my-app"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund
3. context({name: "processPayment", repo: "my-app"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction
4. Read src/payments/processor.ts for implementation details
```
