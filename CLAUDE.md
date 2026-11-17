# Releasing

A release bumps `version` in both `.claude-plugin/plugin.json` and `code-mode/.claude-plugin/plugin.json` when the
change touches code both plugins share (`code-mode/hooks/logic.ts`), then gets a tag and a GitHub release on the bump
commit:

```sh
gh release create v<version> --target <bump commit> --title "<version> (Code Mode <code-mode version>)" --notes "<what changed, one line per change>"
```

Installs dont
