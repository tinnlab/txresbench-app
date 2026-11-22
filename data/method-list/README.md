# The method list — app side

The method list (`method-list.json`) carries both halves of the method facts the app runs
on, as they are, under one header: the catalogue (`catalogue`, schema_version 1) and the
environment images list (`images`, schema_version 2). A maintainer signs it with minisign
and publishes it to `ghcr.io/tinnlab/txresbench-method-list` (`v1-seq-<N>` immutable, `v1`
moving); an app release imports it as its built-in copy.

The list's DATA lives in the methods repository, folder `method-list/` (`catalogue.json`,
`method-env-images.json`, the assembled `method-list.json`); a method change is a
methods-repository PR. The TOOLS live in this repository and work on a methods checkout:

| tool | what |
|---|---|
| `scripts/assemble-method-list.py` | writes `method-list.json` from the two documents (sequence = previous + 1), checks parity, extracts, compares |
| `scripts/method-catalogue/gen_method_catalogue.py --only <id>` | rebuilds one catalogue row |
| `scripts/check-method-list.sh` | the guard: `--list-dir <methods>/method-list` before a methods PR is merged; app mode in the gate |
| `scripts/publish-method-list.sh` | signs and publishes what the methods repository's main holds (maintainers) |
| `scripts/import-method-list.sh` | makes the published list this release's built-in copy |
| `txresbench check-method-list` | the app's own verifier and loader, run by the publisher and the import (`src-app/server/src/modules/method_list/`) |

The steps are in `docs/runbooks/method-env-images-publish.md` §8 (updating a method) and §9
(an app release).

## Files here

| file | what |
|---|---|
| `trusted-keys.json` | the minisign public keys the app trusts to sign a list, compiled into the app |
| `method-list.schema.json` | the header schema (the nested documents keep their own) |
| `method-list.json`, `method-list.json.minisig` | the built-in copy, written only by `scripts/import-method-list.sh` (sequence 0 = the unsigned bootstrap copy, before the first publish; it has no `.minisig`). The app embeds this file and nothing else of the method facts. |

`data/method-catalogue/catalogue.json` and `src-app/server/data/method-env-images.json`
are the built-in list's two documents, extracted by the import to the paths the app and
its tools read. Like `method-list.json`, they are imported copies: never edit them here.

## Trusted keys

One key per publishing maintainer, plus the PI's backup key kept offline. A record is the
key holder's label, the key id minisign prints, and the key line of their `minisign.pub`:

```json
{ "label": "<name> (maintainer)", "key_id": "<16 hex, as minisign prints it>",
  "public_key": "RW..." }
```

Each key holder makes their own key pair on their own machine and keeps the secret key
there (no one else ever holds it):

```sh
minisign -G -p txresbench-method-list.pub -s ~/.minisign/txresbench-method-list.key
chmod 600 ~/.minisign/txresbench-method-list.key
```

and adds the record in an app PR. The guard checks each `key_id` against its key and that
the test key of `scripts/method-list/fixtures/` (its secret half is committed) is never in
this file. A list signed by a key that is not here is refused by the app. Adding or
removing a key reaches installed apps with the next app release; an app keeps its last
good list in the meantime.

## How the app uses the list

The app embeds `method-list.json` (+ `.minisig`) and nothing else of the method facts. At
start it uses the newest valid list among that built-in copy and the last good list it
stored (`<app data>/method-list/v2/`), then asks the registry for a newer one in the
background; it asks again before each run (short budgets) and from the Settings button,
never on a timer. A list is verified before it is parsed, and the highest valid sequence
wins (a lower one is a rollback, the same one with other bytes a conflict: both refused).
Each request and each run reads ONE snapshot of the list; a run keeps its list to the end.
Details: `docs/runbooks/method-env-images-publish.md` §10 and
`src-app/server/src/modules/method_list/`.

