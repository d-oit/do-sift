# Task record template

Copy into the plan file's task table; append evidence when done.

```markdown
| <ID> | <one-line task> | <status> | <evidence> |
```

Evidence block (append below the table when the task completes):

```markdown
### <ID> evidence — <date>
Files: ...
Commands: `<exact command>` → <pass/fail + key output>
Risks/open questions: ...
Status: done | blocked (reason)
```

Rules:
- "Tests pass" without the exact command is not evidence.
- One owner per writable task; note hand-offs.
- Blocked tasks must name the blocker and the next decision needed.
