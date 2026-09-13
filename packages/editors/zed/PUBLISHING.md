# Publishing the Zed Extension

We do not currently have an automated release pipeline for the Zed extension. When publishing a new version, follow this manual checklist:

1. **Commit your grammar changes:** Zed's extension framework requires a committed SHA for the grammar because it checks out the repository. Make sure all changes in `packages/editors/tree-sitter-solidmx` are committed and pushed.
2. **Update the grammar URL:** In `extension.toml`, swap the `file://` path for the grammar to the public GitHub URL (and the exact commit SHA) of the repository.
   - E.g., `path = "packages/editors/tree-sitter-solidmx"` -> `git = "https://github.com/..."` (and set `rev`).
3. **Bump the extension version:** Update the `version` field in `extension.toml` as appropriate.
4. **Publish:** Run the publish command from within the `packages/editors/zed` directory:
   ```bash
   zed extension publish
   ```
