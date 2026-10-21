# Upstream of this app

A copy, unchanged, of the cytoanalyst repository (app #2 on the ziee SDK), taken 2026-10-21 from
`/data/pbya/cytoanalyst/cytoanalyst`:

| part | commit |
|---|---|
| repository | 91d07c57d |
| `sdk/` (submodule `ziee-ai/sdk`, branch `cyto`) | 924d3d6 |
| `agent-kit/` (submodule `ziee-ai/agent-kit`) | 8d4ef02 |

`sdk/` and `agent-kit/` are plain folders here (their git history is not copied). Left out: `.git`, `target/`, `node_modules/`,
`.cyto-cache`, `.ziee-cache`, `cytoanalyst-data/`, `.dsh`, logs, `__pycache__`, `.pytest_cache`.

`UPSTREAM.sha256` holds the checksum of every copied file. A file that differs from its line there has been changed here:

    cd dev/app && sha256sum --check --quiet UPSTREAM.sha256 2>&1 | grep -v ': OK'
