//! **#160 — declared-depth member matching, through the full production path.**
//!
//! A vendor bundle whose sub-directories mirror one another writes the SAME basenames
//! several times over (the motivating case is a spatial platform's three square-bin
//! directories, each a full copy of the single-resolution layout). Under basename-only
//! member matching every declared member had three candidates,
//! `detect_manifest_group` returned nothing, and — because a `Manifest` layout with ONE
//! file passes `enforce_cardinality` and the declared datatype wins for every group —
//! the upload landed as N one-file datasets EACH STAMPED WITH THE BUNDLE TYPE, HTTP
//! 200, no error anywhere.
//!
//! These tests drive the real spawned server + Postgres + blob store and assert both
//! halves of the fix: a nested bundle becomes ONE dataset whose members each name their
//! sub-directory, and every shape that cannot be resolved is REFUSED BY NAME instead of
//! silently degrading.
//!
//! **Nothing here spells a datatype id or a member filename.** Both containers are
//! DERIVED from the live registry over `GET /datatypes`, selected by the SHAPE of their
//! declaration — one whose members carry path segments, one whose members are bare
//! basenames that the first one's members end with. That is not only a domain-lint
//! constraint: it is what makes these tests assertions about the MECHANISM rather than
//! about one vendor, so they keep meaning the same thing when the declarations move.

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};

use super::setup_admin;
use crate::common::TestServer;

/// A container the upload planner can auto-group: its declared member list, and its id.
#[derive(Debug, Clone)]
struct Container {
    id: String,
    members: Vec<String>,
}

impl Container {
    /// How many path segments the DEEPEST declared member carries.
    fn depth(&self) -> usize {
        self.members
            .iter()
            .map(|m| m.split('/').count())
            .max()
            .unwrap_or(0)
    }
    /// The last path segment of each member's first `|`-alternative.
    fn basenames(&self) -> Vec<String> {
        self.members
            .iter()
            .map(|m| {
                m.split('|')
                    .next()
                    .unwrap_or(m)
                    .trim()
                    .rsplit('/')
                    .next()
                    .unwrap_or(m)
                    .to_string()
            })
            .collect()
    }
}

/// Every declared multi-member container in the LIVE registry, read over the API.
async fn containers(server: &TestServer, token: &str) -> Vec<Container> {
    let r = server
        .client
        .get(server.api_url("/datatypes"))
        .bearer_auth(token)
        .send()
        .await
        .expect("GET /datatypes");
    assert_eq!(r.status().as_u16(), 200);
    let types: Value = r.json().await.expect("json");
    let mut out = Vec::new();
    for dt in types.as_array().expect("array") {
        let ir = &dt["input_requirements"];
        if ir["requires"] != json!("manifest") {
            continue;
        }
        let Some(members) = ir["members"].as_array() else {
            continue;
        };
        if members.len() < 2 {
            continue;
        }
        out.push(Container {
            id: dt["id"].as_str().expect("id").to_string(),
            members: members
                .iter()
                .map(|m| m.as_str().expect("member").to_string())
                .collect(),
        });
    }
    assert!(
        !out.is_empty(),
        "no multi-member container is declared — every assertion below would be vacuous"
    );
    out
}

/// The two subjects, derived rather than named:
///
/// * `nested` — the container whose members carry the MOST path segments. This is the
///   one #160 made expressible; without one, the depth rule is dead code and this test
///   says so rather than passing.
/// * `flat` — a container whose members are ALL bare basenames AND which `nested`'s
///   members END WITH, so a `nested` upload gives it several candidates per member.
///   That relationship is exactly the ambiguity #160 must keep refusing.
async fn nested_and_colliding_flat(server: &TestServer, token: &str) -> (Container, Container) {
    let all = containers(server, token).await;
    let nested = all
        .iter()
        .max_by_key(|c| c.depth())
        .cloned()
        .expect("at least one container");
    assert!(
        nested.depth() >= 2,
        "NO declared container carries a path-segment member, so the mechanism this file \
         tests is not reachable from any shipped declaration"
    );
    let nested_bases = nested.basenames();
    let flat = all
        .iter()
        .filter(|c| c.id != nested.id && c.depth() == 1)
        .find(|c| {
            c.basenames()
                .iter()
                .filter(|b| nested_bases.contains(b))
                .count()
                >= 2
        })
        .cloned()
        .expect(
            "no basename container shares members with the nested one — the ambiguity leg \
             below would be testing nothing",
        );
    (nested, flat)
}

fn part(name: &str, bytes: &[u8]) -> Part {
    Part::bytes(bytes.to_vec()).file_name(name.to_string())
}

async fn upload(server: &TestServer, token: &str, form: Form) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

/// How many datasets the caller's library holds — the control that makes "refused"
/// mean "nothing was created" rather than "the response was a 400 AND four datasets".
async fn dataset_count(server: &TestServer, token: &str) -> i64 {
    let resp = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.unwrap();
    body["total"].as_i64().expect("the list page reports a total")
}

/// The relative paths a folder-picked bundle sends for `c`'s members: each declared
/// member's first spelling, under a run root the USER named — the matcher anchors at
/// the path SUFFIX and must not care what the bundle folder is called.
fn member_paths(c: &Container) -> Vec<String> {
    c.members
        .iter()
        .map(|m| {
            let spelling = m.split('|').next().unwrap_or(m).trim();
            format!("MyRun_2024-06/vendor_root/{spelling}")
        })
        .collect()
}

fn form_of(paths: &[String], datatype: Option<&str>) -> Form {
    let mut form = Form::new();
    for (i, p) in paths.iter().enumerate() {
        // Distinct bytes per part, so a dataset that ended up holding the same file
        // three times would be visible in the stored content, not just in the names.
        form = form.part("file", part(p, format!("payload {i} for {p}").as_bytes()));
    }
    if let Some(dt) = datatype {
        form = form.text("datatype", dt.to_string());
    }
    form
}

/// **TEST-1 `[acceptance]` `[invariant: INV-1]`** — a nested vendor bundle becomes ONE
/// dataset, and each declared member binds to ITS OWN sub-directory.
///
/// The count is not the claim; the BINDING is. A matcher that grouped the right NUMBER
/// of files out of one sub-directory, or bound every member to the same file, produces
/// the same "1 dataset, N files" and is caught by the per-directory assertions below.
#[tokio::test]
async fn a_nested_vendor_bundle_uploads_as_one_dataset_with_its_subdirectories_intact() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (nested, _flat) = nested_and_colliding_flat(&server, &admin).await;

    let paths = member_paths(&nested);
    let (status, body) = upload(&server, &admin, form_of(&paths, Some(&nested.id))).await;
    assert_eq!(status, 200, "the nested bundle uploads: {body}");

    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(
        datasets.len(),
        1,
        "{} declared members across several sub-directories are ONE dataset, not {} \
         (this is the outcome that returned `None` from `detect_manifest_group` before \
         #160): {body}",
        nested.members.len(),
        nested.members.len()
    );
    // Read BY NAME, never by position: the dataset this assertion is about is the one
    // typed as the declared container, and saying so is what makes a second, differently
    // typed dataset a failure rather than something index 0 silently steps over.
    let ds = datasets
        .iter()
        .find(|d| d["datatype"] == json!(nested.id))
        .unwrap_or_else(|| panic!("no dataset typed as the declared container: {body}"));

    let files = ds["files"].as_array().unwrap();
    assert_eq!(
        files.len(),
        nested.members.len(),
        "one file per declared member: {body}"
    );

    let stored: Vec<String> = files
        .iter()
        .map(|f| f["filename"].as_str().unwrap().to_string())
        .collect();

    // Every uploaded relative path is retained VERBATIM, so the dataset record itself
    // says which sub-directory each member came from — the property that makes
    // "unambiguous" true of the stored dataset and not only of the matcher.
    for p in &paths {
        assert!(
            stored.contains(p),
            "the vendor-relative path {p:?} is not stored on the dataset: {stored:?}"
        );
    }

    // …and each declared sub-directory contributed exactly its own members. This is the
    // clause a "took the right number from the wrong place" matcher fails.
    let mut by_dir: std::collections::BTreeMap<&str, usize> = std::collections::BTreeMap::new();
    for m in &nested.members {
        if let Some((dir, _)) = m.split_once('/') {
            *by_dir.entry(dir).or_default() += 1;
        }
    }
    assert!(
        by_dir.len() >= 2,
        "the nested container declares members in fewer than two sub-directories, so the \
         per-directory assertion below is vacuous: {:?}",
        nested.members
    );
    for (dir, want) in &by_dir {
        let got = stored
            .iter()
            .filter(|s| s.contains(&format!("/{dir}/")))
            .count();
        assert_eq!(
            got, *want,
            "sub-directory {dir} contributed {got} member(s), not {want} — the group took \
             the wrong files even though it took the right NUMBER of them: {stored:?}"
        );
    }

    // The identically-named siblings are stored as DIFFERENT paths.
    let bases = nested.basenames();
    let repeated: Vec<&String> = bases
        .iter()
        .filter(|b| bases.iter().filter(|x| x == b).count() > 1)
        .collect();
    assert!(
        !repeated.is_empty(),
        "the nested container declares no repeated basename, so it is not the collision \
         case this file exists for: {:?}",
        nested.members
    );
    for base in repeated {
        let hits: Vec<&String> = stored.iter().filter(|s| s.ends_with(base)).collect();
        let distinct: std::collections::BTreeSet<&&String> = hits.iter().collect();
        assert_eq!(
            hits.len(),
            distinct.len(),
            "the sub-directories' copies of {base:?} collapsed onto one path: {hits:?}"
        );
    }
}

/// **TEST-5 `[acceptance]` `[invariant: INV-3]`** — the "quietly the wrong sub-directory"
/// case.
///
/// The SAME uploaded paths, declared as the BASENAME container whose members several of
/// those files match. Each such member has more than one candidate. The upload must be
/// refused by name — it must not pick one, and it must not quietly succeed just because
/// a DIFFERENT declared container would have matched these files.
///
/// This is a two-arm comparison that can genuinely fail: the arms differ only in the
/// declared datatype, over byte-identical uploaded paths, and they are asserted to reach
/// different outcomes (TEST-1's 200 + one dataset vs this 400 + zero datasets).
#[tokio::test]
async fn the_basename_container_refuses_a_nested_bundle_rather_than_picking_one() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (nested, flat) = nested_and_colliding_flat(&server, &admin).await;
    let before = dataset_count(&server, &admin).await;

    let (status, body) = upload(
        &server,
        &admin,
        form_of(&member_paths(&nested), Some(&flat.id)),
    )
    .await;
    assert_eq!(
        status, 400,
        "an ambiguous member is a refusal, never a pick: {body}"
    );
    let text = body.to_string();
    assert!(
        text.contains("MANIFEST_GROUP_INCOMPLETE"),
        "refused by the named error: {text}"
    );
    // The message names at least one member that had several candidates, so the user is
    // told WHICH declaration could not be resolved rather than that something failed.
    let shared: Vec<String> = flat
        .basenames()
        .into_iter()
        .filter(|b| nested.basenames().contains(b))
        .collect();
    assert!(
        shared.iter().any(|b| text.contains(b.as_str())),
        "the message names none of the colliding members {shared:?}: {text}"
    );
    assert_eq!(
        dataset_count(&server, &admin).await,
        before,
        "a refused upload creates NOTHING — the shipped behaviour created one dataset per \
         file, each stamped with the declared bundle type"
    );
}

/// **TEST-4 `[acceptance]` `[invariant: INV-3]`** — an INCOMPLETE declared bundle is
/// refused by name, and the shipped silent outcome is asserted gone.
#[tokio::test]
async fn an_incomplete_declared_bundle_is_refused_and_nothing_is_created() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (_nested, flat) = nested_and_colliding_flat(&server, &admin).await;
    let before = dataset_count(&server, &admin).await;

    // The basename container's own members, with exactly one left out.
    let mut paths = member_paths(&flat);
    let dropped = paths.pop().expect("the container declares members");
    let missing_member = flat.members.last().unwrap().clone();
    assert!(!paths.is_empty(), "at least one member is still uploaded");

    let (status, body) = upload(&server, &admin, form_of(&paths, Some(&flat.id))).await;
    assert_eq!(
        status, 400,
        "the incomplete bundle is refused (dropped {dropped}): {body}"
    );
    let text = body.to_string();
    assert!(
        text.contains(&missing_member),
        "the message names the MISSING member so the user knows what to add: {text}"
    );
    assert_eq!(
        dataset_count(&server, &admin).await,
        before,
        "the shipped outcome — one dataset per uploaded file, each stamped with the \
         declared container's type, HTTP 200, no error — is gone"
    );
}

/// **TEST-10** — the three exclusions of the refusal, each load-bearing.
///
/// Without any one of them this change would break a shipped path, so each is driven
/// here rather than argued in a comment.
#[tokio::test]
async fn the_refusal_leaves_the_archive_untyped_and_explicit_paths_alone() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (nested, _flat) = nested_and_colliding_flat(&server, &admin).await;

    // (a) a DECLARED manifest type with exactly ONE file is the archive contract.
    let form = Form::new()
        .part("file", part("bundle.zip", b"\x50\x4b\x03\x04 fake zip"))
        .text("datatype", nested.id.clone());
    let (status, body) = upload(&server, &admin, form).await;
    assert_eq!(status, 200, "a declared-type archive still uploads: {body}");
    let created = body["datasets"].as_array().unwrap();
    assert_eq!(created.len(), 1);
    assert!(
        created.iter().any(|d| d["datatype"] == json!(nested.id)),
        "the archive is typed as the declared container: {body}"
    );

    // (b) an UNTYPED multi-file upload that does not group keeps the DEC-2 default:
    //     one dataset per file, 200. There is no stated intent to contradict.
    let (status, body) = upload(
        &server,
        &admin,
        form_of(&["loose_a.bin".to_string(), "loose_b.bin".to_string()], None),
    )
    .await;
    assert_eq!(status, 200, "the untyped default is untouched: {body}");
    assert_eq!(
        body["datasets"].as_array().unwrap().len(),
        2,
        "one dataset per file, exactly as before"
    );

    // (c) an EXPLICIT `groups` partition stays authoritative even for a declared
    //     manifest type — the caller stated the grouping, so nothing is inferred.
    let mut form = Form::new();
    for p in ["one.bin", "two.bin"] {
        form = form.part("file", part(p, b"bytes"));
    }
    let form = form.text("groups", "[[0,1]]").text("datatype", nested.id.clone());
    let (status, body) = upload(&server, &admin, form).await;
    assert_eq!(status, 200, "an explicit grouping is honoured: {body}");
    assert_eq!(body["datasets"].as_array().unwrap().len(), 1);
}

/// **TEST-20** — a declared bundle upload carrying files that are NOT its members is
/// refused, and a single non-archive file is not exempt either.
///
/// The planner makes ONE dataset per unmatched file, so a whole vendor output tree declared
/// as its container produced one correct bundle plus up to `max_upload_parts` junk
/// datasets — HTTP 200, no warning, and no way to undo them in one action. An earlier
/// narrowing of this rule allowed it, citing a `detect_manifest_group` unit-test comment as
/// though it described what the HANDLER creates. The cost of refusing is one named message;
/// the cost of not refusing is a thousand rows.
#[tokio::test]
async fn a_declared_bundle_upload_with_undeclared_extras_is_refused() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (nested, _flat) = nested_and_colliding_flat(&server, &admin).await;
    let before = dataset_count(&server, &admin).await;

    let mut paths = member_paths(&nested);
    paths.push("MyRun_2024-06/run_report.html".into());
    paths.push("MyRun_2024-06/vendor_root/notes/scratch.txt".into());

    let (status, body) = upload(&server, &admin, form_of(&paths, Some(&nested.id))).await;
    assert_eq!(status, 400, "the extras are refused, not minted: {body}");
    let text = body.to_string();
    assert!(text.contains("MANIFEST_GROUP_INCOMPLETE"), "{text}");
    assert!(
        text.contains("2 other file"),
        "the message says HOW MANY files are not declared members: {text}"
    );
    assert_eq!(dataset_count(&server, &admin).await, before);

    // ONE non-archive file declared as a manifest type is refused too. Exempting a single
    // file left the original defect open on the shortest path to it: the wizard's Archive
    // arm accepts a drop of anything (its `accept` glob is advisory), so `notes.txt` became
    // a dataset stamped with the bundle type, with the bundle's converter enqueued to fail
    // asynchronously — the exact outcome this item exists to close.
    let (status, body) = upload(
        &server,
        &admin,
        form_of(&["notes.txt".to_string()], Some(&nested.id)),
    )
    .await;
    assert_eq!(
        status, 400,
        "one non-archive file is not a bundle either: {body}"
    );
    assert_eq!(dataset_count(&server, &admin).await, before);

    // …and the bundle ALONE still uploads, so the refusal above is about the extras.
    let (status, body) = upload(&server, &admin, form_of(&member_paths(&nested), Some(&nested.id)))
        .await;
    assert_eq!(status, 200, "{body}");
    let created = body["datasets"].as_array().unwrap();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0]["datatype"], json!(nested.id));
    // named after the FOLDER the user picked, not after a file inside it.
    let root = member_paths(&nested)[0].split('/').next().unwrap().to_string();
    assert_eq!(created[0]["name"], json!(root));
}

/// **TEST-25** — a part filename longer than the column can store is refused BY NAME,
/// before anything is created.
///
/// Two things break without this bound, and both are reachable now that a part filename
/// carries a relative PATH rather than a basename: `files.filename` is `varchar(255)`, so a
/// longer name raises a Postgres 22001 from INSIDE the per-group ingest loop — a 500 with
/// earlier groups already committed as datasets and their converters enqueued; and member
/// matching splits the whole path, which a multipart header may carry ~64 KiB of, per part,
/// synchronously inside this handler (measured at ~70 s for one request).
#[tokio::test]
async fn an_over_long_part_filename_is_refused_before_anything_is_created() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let before = dataset_count(&server, &admin).await;

    // A deep path well past the storable length — the shape a matcher would have split
    // once per member, per carrier.
    let deep: String = std::iter::repeat("segment/").take(64).collect::<String>() + "counts.h5";
    assert!(deep.chars().count() > 255);

    let (status, body) = upload(&server, &admin, form_of(&[deep], None)).await;
    assert_eq!(status, 400, "an over-long part filename is refused: {body}");
    assert!(
        body.to_string().contains("FILENAME_TOO_LONG"),
        "refused by the named error rather than by a 500 from the database: {body}"
    );
    assert_eq!(
        dataset_count(&server, &admin).await,
        before,
        "and nothing was created — the failure this replaces landed mid-loop, after \
         earlier groups were already committed"
    );

    // The message NAMES the offending file, elided. "an uploaded file's name is 312 bytes"
    // is unactionable when the upload carried hundreds.
    let text = body.to_string();
    assert!(
        text.contains("segment/segment"),
        "the message names (a prefix of) the offending path: {text}"
    );

    // CHARACTERS, not bytes. `varchar(255)` counts characters, so a byte bound both refuses
    // a legitimate ~90-character multi-byte path and quotes a number the user cannot
    // reconcile with what they see. This path is 184 characters and 424 bytes.
    let multibyte: String = "\u{6570}\u{636e}/".repeat(60) + "x.h5";
    assert!(multibyte.chars().count() <= 255 && multibyte.len() > 255);
    let (status, body) = upload(&server, &admin, form_of(&[multibyte], None)).await;
    assert_eq!(
        status, 200,
        "a 184-character path is 424 bytes and must NOT be refused for length: {body}"
    );

    // The bound must not refuse a REAL vendor-relative path — the whole point of this item
    // depends on those going through. Asserted rather than assumed.
    let (nested, _flat) = nested_and_colliding_flat(&server, &admin).await;
    for p in member_paths(&nested) {
        assert!(
            p.chars().count() <= 255,
            "a declared member's own upload path is over the limit ({}): {p}",
            p.chars().count()
        );
    }
    let (status, body) = upload(&server, &admin, form_of(&member_paths(&nested), Some(&nested.id)))
        .await;
    assert_eq!(status, 200, "a real bundle still uploads: {body}");
}

/// **TEST-28** — a multi-file group whose paths carry NO usable folder still gets a name.
///
/// The dataset is named after the folder the user picked, which is the first path segment.
/// A non-browser client may send `.`/`..` segments, and an earlier fallback re-admitted the
/// very `..` the filter had just excluded (and split on one separator only, so `C:\run\a.h5`
/// produced a dataset named `C:`). A dataset called `..` helps nobody.
#[tokio::test]
async fn a_group_whose_paths_carry_no_usable_folder_is_still_named_sanely() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Two files, explicitly grouped (so no declaration is involved), whose paths are made
    // entirely of segments the name derivation must reject.
    let mut form = Form::new();
    for p in ["../../a.bin", "../../b.bin"] {
        form = form.part("file", part(p, b"bytes"));
    }
    let (status, body) = upload(&server, &admin, form.text("groups", "[[0,1]]")).await;
    assert_eq!(status, 200, "{body}");
    let created = body["datasets"].as_array().unwrap();
    assert_eq!(created.len(), 1);
    let name = created[0]["name"].as_str().unwrap();
    assert_ne!(name, "..", "a dataset called `..` is what the filter exists to prevent");
    assert!(!name.is_empty(), "and an empty name is no better");
    assert!(
        !name.contains('/') && !name.contains('\\'),
        "the name is a NAME, never a path: {name:?}"
    );
}

/// **TEST-24** — N archives of a declared manifest type still upload.
///
/// A declared manifest type also accepts a BUNDLED archive, and an archive satisfies no
/// member by design. The refusal must not read "no member resolved" as a defect when the
/// upload contains no members at all — that would narrow a shipped, unversioned route over
/// a shape the wizard never emits but an API caller legitimately can. The escape is about
/// ARCHIVES, not about count, which the second half asserts.
#[tokio::test]
async fn several_archives_of_a_declared_manifest_type_still_upload() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (nested, _flat) = nested_and_colliding_flat(&server, &admin).await;

    let archives = [
        "run_one.zip".to_string(),
        "run_two.tar.gz".to_string(),
        "run_three.tgz".to_string(),
    ];
    let (status, body) = upload(&server, &admin, form_of(&archives, Some(&nested.id))).await;
    assert_eq!(status, 200, "N archives of a declared type still upload: {body}");
    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), archives.len(), "one dataset per archive: {body}");
    for d in datasets {
        assert_eq!(d["datatype"], json!(nested.id), "each is the declared type: {body}");
        assert_eq!(d["files"].as_array().unwrap().len(), 1);
    }

    // …and the escape is NOT a count exemption: a PARTIAL member set of the same size is
    // still refused, because there the user was plainly assembling the bundle.
    let partial: Vec<String> = member_paths(&nested).into_iter().take(3).collect();
    let (status, body) = upload(&server, &admin, form_of(&partial, Some(&nested.id))).await;
    assert_eq!(status, 400, "a partial member set is still refused: {body}");
    assert!(body.to_string().contains("MANIFEST_GROUP_INCOMPLETE"));

    // …nor does it apply to a MIXTURE of archives and members.
    let mut mixed = partial.clone();
    mixed.push("run_four.zip".to_string());
    let (status, body) = upload(&server, &admin, form_of(&mixed, Some(&nested.id))).await;
    assert_eq!(status, 400, "archives mixed with members are still refused: {body}");
}

/// **TEST-21 `[acceptance]` `[invariant: INV-3]`** — members gathered from THREE DIFFERENT
/// bundle roots are refused, end to end.
///
/// Every declared member still resolves to exactly one file, so nothing is "ambiguous";
/// only WHERE the files came from is wrong. Grouping them would produce a 200 and a
/// dataset whose several resolutions describe several different specimens — the silently
/// wrong outcome the one-dataset decision rests on not happening.
#[tokio::test]
async fn members_gathered_from_different_bundle_roots_are_refused_end_to_end() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (nested, _flat) = nested_and_colliding_flat(&server, &admin).await;
    let before = dataset_count(&server, &admin).await;

    // Give each declared member its OWN run root, keeping its declared segments intact.
    let scattered: Vec<String> = nested
        .members
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let spelling = m.split('|').next().unwrap_or(m).trim();
            format!("Run{i}_outs/vendor_root/{spelling}")
        })
        .collect();

    let (status, body) = upload(&server, &admin, form_of(&scattered, Some(&nested.id))).await;
    assert_eq!(
        status, 400,
        "members from different bundles must not group: {body}"
    );
    let text = body.to_string();
    assert!(text.contains("MANIFEST_GROUP_INCOMPLETE"), "{text}");
    assert!(
        text.contains("different directories"),
        "the message says WHY — that the parts are not one bundle: {text}"
    );
    assert_eq!(dataset_count(&server, &admin).await, before);

    // CONTROL: the same members under ONE root DO group, so the refusal above is about
    // the roots and not about this input being unmatchable.
    let (status, body) = upload(&server, &admin, form_of(&member_paths(&nested), Some(&nested.id)))
        .await;
    assert_eq!(status, 200, "the one-root form still uploads: {body}");
    assert_eq!(body["datasets"].as_array().unwrap().len(), 1);
}
