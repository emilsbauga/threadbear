// The golden files: for every mock-runner fixture (mock-runner/fixtures),
// the rows this reducer makes from its events must match, row for row,
// tests/golden/<fixture>.json. The frozen Swift app's reducer reads the same
// files (GoldenTranscriptTests.swift), so the two agree. Either side
// rewrites them with UPDATE_GOLDEN=1:
//
//   cd desktop && UPDATE_GOLDEN=1 cargo test -p threadbear-core --test golden
//
// in Swift's own format (pretty, sorted keys, " : "), so a rewrite from
// here shows only what really changed; a_rewrite_changes_nothing checks the
// files are in that format. Look at the diff before committing it: it's
// what changed in how the transcript folds.
//
// As in the Swift test: the thread's status plays no part, because the
// Working row comes from the events alone (a turn.started with no
// turn.completed); only the root, background work and loose-ends check
// come from thread.json, as in ThreadSession.open. Nothing in the row text
// depends on the time or the machine, so nothing is normalised out.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a test: a panic is its failure, with the line"
)]
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use threadbear_core::reducer::*;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repo root")
        .to_path_buf()
}

fn golden_rows(model: &TranscriptModel) -> Vec<Value> {
    model.rows().iter().map(golden_row).collect()
}

fn golden_row(row: &Row) -> Value {
    let mut fields = serde_json::Map::new();
    fields.insert("id".into(), json!(row.id));
    fields.insert("kind".into(), json!(row.kind().as_str()));
    fields.insert("text".into(), json!(RowDebug::excerpt(row, 100)));
    if opens(row) {
        fields.insert("expanded".into(), json!(is_expanded(row)));
    }
    fields.insert("inGroup".into(), json!(row.in_group));
    fields.insert("seq".into(), json!(row.seq));
    if let Some(turn) = &row.turn_id {
        fields.insert("turn".into(), json!(turn));
    }
    Value::Object(fields)
}

/// AppDump.opens: the rows that show a chevron.
fn opens(row: &Row) -> bool {
    match &row.content {
        RowContent::Group(_) | RowContent::Tool(_) | RowContent::Reasoning(_) => true,
        RowContent::Approval(item) => item.resolution.is_some() && item.opens(),
        _ => false,
    }
}

/// A group carries its open state; item rows keep theirs in the app's
/// session, which is empty here (TranscriptController.isExpanded).
fn is_expanded(row: &Row) -> bool {
    matches!(&row.content, RowContent::Group(group) if group.is_expanded)
}

fn load_fixture(folder: &Path) -> (Vec<Event>, String, Vec<BackgroundTask>, Option<LooseEnds>) {
    let ndjson = fs::read_to_string(folder.join("events.ndjson")).expect("events.ndjson");
    let events: Vec<Event> = ndjson
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: Value = serde_json::from_str(line).expect("an event line");
            Event::decode(&value).expect("an event object")
        })
        .collect();
    let thread: Value =
        serde_json::from_str(&fs::read_to_string(folder.join("thread.json")).expect("thread.json"))
            .expect("thread.json parses");
    let cwd = thread
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let background = thread
        .get("background")
        .and_then(Value::as_array)
        .map(|tasks| tasks.iter().filter_map(BackgroundTask::decode).collect())
        .unwrap_or_default();
    let loose_ends = thread.get("looseEnds").and_then(LooseEnds::decode);
    (events, cwd, background, loose_ends)
}

fn check_rows(
    name: &str,
    which: &str,
    produced: &[Value],
    expected: Option<&Value>,
    failures: &mut Vec<String>,
) {
    let Some(expected) = expected.and_then(Value::as_array) else {
        failures.push(format!("{name} {which}: no rows in the golden file"));
        return;
    };
    let produced_ids: Vec<&str> = produced
        .iter()
        .map(|r| r["id"].as_str().unwrap_or(""))
        .collect();
    let expected_ids: Vec<&str> = expected
        .iter()
        .map(|r| r["id"].as_str().unwrap_or(""))
        .collect();
    if produced_ids != expected_ids {
        failures.push(format!("{name} {which}: the row ids differ\n  produced {produced_ids:?}\n  expected {expected_ids:?}"));
        return;
    }
    for (produced_row, expected_row) in produced.iter().zip(expected) {
        if produced_row != expected_row {
            failures.push(format!(
                "{name} {which}: {}\n  produced {produced_row}\n  expected {expected_row}",
                expected_row["id"]
            ));
        }
    }
}

#[test]
fn every_fixture_matches_its_golden_file() {
    let repo = repo_root();
    let fixtures = repo.join("mock-runner/fixtures");
    let golden = repo.join("desktop/core/tests/golden");
    let mut names: Vec<String> = fs::read_dir(&fixtures)
        .expect("the fixtures folder")
        .map(|e| {
            e.expect("an entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| fixtures.join(name).join("events.ndjson").exists())
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no fixtures found");

    let mut failures = Vec::new();
    for entry in fs::read_dir(&golden).expect("the golden folder") {
        let file = entry
            .expect("an entry")
            .file_name()
            .to_string_lossy()
            .into_owned();
        if let Some(stem) = file.strip_suffix(".json") {
            if !names.iter().any(|n| n == stem) {
                failures.push(format!("{file} has no fixture"));
            }
        }
    }

    for name in &names {
        let (events, cwd, background, loose_ends) = load_fixture(&fixtures.join(name));
        // As ThreadSession.open does for a thread that's opened.
        let mut model = TranscriptModel::new(Some(cwd));
        model.set_loose_ends(loose_ends);
        model.load(events, &[]);
        model.set_background(background);
        let closed = golden_rows(&model);

        // Every group open, so the steps folded in them show.
        let group_ids: Vec<String> = model
            .rows()
            .iter()
            .filter(|r| r.kind() == RowKind::Group)
            .map(|r| r.id.clone())
            .collect();
        for id in group_ids {
            model.set_expanded(&id, true);
        }
        let open = golden_rows(&model);

        let golden_path = golden.join(format!("{name}.json"));
        if updating() {
            let file = json!({ "closed": closed, "open": open });
            fs::write(&golden_path, swift_json(&file)).expect("a golden file written");
            continue;
        }
        let text = match fs::read_to_string(&golden_path) {
            Ok(text) => text,
            Err(_) => {
                failures.push(format!(
                    "{name}: no golden file (write it with UPDATE_GOLDEN=1, see the top of golden.rs)"
                ));
                continue;
            }
        };
        let expected: Value = serde_json::from_str(&text).expect("a golden file parses");
        check_rows(
            name,
            "closed",
            &closed,
            expected.get("closed"),
            &mut failures,
        );
        check_rows(name, "open", &open, expected.get("open"), &mut failures);
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn updating() -> bool {
    std::env::var("UPDATE_GOLDEN").as_deref() == Ok("1")
}

/// A golden file as Swift's JSONEncoder writes it ([.prettyPrinted,
/// .sortedKeys, .withoutEscapingSlashes]), the format the files are in.
fn swift_json(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, 0, &mut out);
    out.push('\n');
    out
}

fn write_json(value: &Value, depth: usize, out: &mut String) {
    let pad = "  ".repeat(depth);
    let (open, close, items): (char, char, Vec<(Option<&String>, &Value)>) = match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().map(|(k, v)| (Some(k), v)).collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            ('{', '}', entries)
        }
        Value::Array(list) => ('[', ']', list.iter().map(|v| (None, v)).collect()),
        Value::String(text) => return write_string(text, out),
        other => return out.push_str(&other.to_string()),
    };
    out.push(open);
    let mut first = true;
    for (key, item) in items {
        out.push_str(if first { "\n" } else { ",\n" });
        first = false;
        out.push_str(&pad);
        out.push_str("  ");
        if let Some(key) = key {
            write_string(key, out);
            out.push_str(" : ");
        }
        write_json(item, depth + 1, out);
    }
    // An empty one too, as Swift writes it: a blank line inside.
    out.push_str(if first { "\n\n" } else { "\n" });
    out.push_str(&pad);
    out.push(close);
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if u32::from(c) < 0x20 => {
                write!(out, "\\u{:04x}", u32::from(c)).expect("a String takes it");
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[test]
fn a_rewrite_changes_nothing() {
    // UPDATE_GOLDEN=1 from here writes exactly the bytes Swift's test did,
    // so the switch from one writer to the other is no diff at all.
    let golden = repo_root().join("desktop/core/tests/golden");
    let mut checked = 0;
    for entry in fs::read_dir(&golden).expect("the golden folder") {
        let path = entry.expect("an entry").path();
        if path.extension().is_some_and(|e| e == "json") {
            // As committed: a Windows checkout may have made the ends CRLF.
            let text = fs::read_to_string(&path)
                .expect("a golden file")
                .replace("\r\n", "\n");
            let value: Value = serde_json::from_str(&text).expect("a golden file parses");
            assert!(
                swift_json(&value) == text,
                "{} isn't as UPDATE_GOLDEN=1 would write it",
                path.display()
            );
            checked += 1;
        }
    }
    assert!(checked > 0, "no golden files found");
}

#[test]
fn strings_are_escaped_as_swift_does() {
    let mut out = String::new();
    // What Swift's JSONEncoder wrote for the same, tried on 21 Nov 2026.
    write_string("a \"b\" c\\d\n\u{1}\u{8}\u{c}\r\t/…", &mut out);
    assert_eq!(out, r#""a \"b\" c\\d\n\u0001\b\f\r\t/…""#);
    assert_eq!(
        swift_json(&json!({ "b": [], "a": {} })),
        "{\n  \"a\" : {\n\n  },\n  \"b\" : [\n\n  ]\n}\n"
    );
}
