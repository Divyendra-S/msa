This folder is an online shop (Next.js and Postgres); README.md says how to run it.

Find bugs in checkout and orders that cost the shop money, lose or corrupt data, or show a user something that isn't true or isn't theirs. For each bug you find:

1. reproduce it,
2. fix it in the code,
3. prove the fix: the reproduction fails before the fix and passes after it.

Work on your own and don't ask questions. Stop when you have fixed what you found, or when you find nothing more.

Finish by writing `bench-report.json` in this folder:

```json
{
  "findings": [
    {
      "title": "one line",
      "summary": "what goes wrong and why",
      "files": ["path/of/the/code/with/the/bug.ts"],
      "reproduce": "one shell command, run from this folder, that exits non-zero while the bug is there and zero once it is fixed; it starts whatever it needs",
      "fixed": true
    }
  ]
}
```

Write `{"findings": []}` if you found none.
