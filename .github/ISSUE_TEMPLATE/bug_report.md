---
name: Bug report
about: Something isn't working as expected
title: "Bug: "
labels: bug
assignees: ''
---

## What happened

A clear, brief description of the bug. What did you do? What did you expect? What actually happened?

## Reproduction

Steps to reproduce:

1. Run `...`
2. Open the diagram panel
3. ...

Minimal `.oxford/model.json` that reproduces the bug, if relevant:

```json
{}
```

## Environment

- little-oxford version: `<from "little-oxford" extension in VS Code Extensions panel>`
- VS Code version: `<Help → About>`
- OS: `<macOS / Linux distro / Windows>`
- Node version (if developing): `<node --version>`

## Logs

If the issue is reproducible, run with `npm run install:debug` (or set `OXFORD_DEBUG=1` when building) and attach the `.oxford/debug.log` from the workspace. Redact anything sensitive.

## Anything else

Stack traces, screenshots, context — whatever helps.
