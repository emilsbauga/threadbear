// A thread pane's read and its paging are each one state now
// (core/src/thread_load.rs, core/src/older_pages.rs). The loose fields they
// replaced in gpui's thread.rs (`loaded`, `load_failed`, `subagent_missing`,
// `stale`, `loading_older`, `older_skip`, `older_failures`) don't come back,
// and the load state has one writer, `ThreadPane::move_load`: a second
// writer is how the old fields drifted apart (a failure left up while it
// read again, an old turn shown as live).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "a test: a panic is its failure, with the line"
)]
use std::path::{Path, PathBuf};

/// The old fields, as code wrote or read them.
const OLD_FIELDS: &[&str] = &[
    "self.loaded",
    "this.loaded",
    "load_failed",
    "subagent_missing",
    "self.stale",
    "this.stale",
    "loading_older",
    "older_skip",
    "older_failures",
];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Code without its comments, so a comment can still name the old fields.
fn code_lines(text: &str) -> impl Iterator<Item = (usize, &str)> {
    text.lines()
        .enumerate()
        .map(|(i, line)| (i + 1, line.split("//").next().unwrap_or("")))
}

#[test]
fn the_pane_has_one_writer_of_its_load_state_and_no_old_fields() {
    let gpui = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("gpui/src");
    let mut files = Vec::new();
    rust_files(&gpui, &mut files);
    let thread = gpui.join("thread.rs");
    assert!(
        files.contains(&thread),
        "thread.rs wasn't found, so this test isn't looking in the right place"
    );
    let mut found = Vec::new();
    let mut writers = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap();
        let name = file.strip_prefix(&gpui).unwrap().display().to_string();
        for (n, code) in code_lines(&text) {
            for old in OLD_FIELDS {
                if code.contains(old) {
                    found.push(format!("{name}:{n}: {}", code.trim()));
                }
            }
            // Anything that sets the pane's `load` other than through
            // `move_load`: an assignment, a swap, a `&mut` borrow of it.
            // (Comparisons taken out first, so one beside an assignment
            // doesn't hide it.)
            let squashed: String = code
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>()
                .replace(".load==", "")
                .replace(".load!=", "");
            let sets = [
                ".load=",
                "&mutself.load",
                "&mutthis.load",
                "load:ThreadLoad::",
            ]
            .iter()
            .any(|w| squashed.contains(w));
            if sets {
                writers.push(format!("{name}:{n}: {}", code.trim()));
            }
        }
    }
    assert!(
        found.is_empty(),
        "the old load fields are back; move the pane's state with move_load \
         (thread_load.rs) or its OlderPages (older_pages.rs) instead:\n{}",
        found.join("\n")
    );
    // move_load's own two lines, and the two constructors' starting state.
    let allowed = [
        "thread.rs: let (load, then) = std::mem::replace(&mut self.load, ThreadLoad::opening()).next(event);",
        "thread.rs: self.load = load;",
        "thread.rs: load: ThreadLoad::opening(),",
        "thread.rs: load: ThreadLoad::opening(),",
    ];
    let mut rest: Vec<String> = writers
        .iter()
        .map(|w| {
            let (file, code) = w.split_once(": ").unwrap();
            let file = file.rsplit_once(':').unwrap().0;
            format!("{file}: {code}")
        })
        .collect();
    for a in allowed {
        if let Some(i) = rest.iter().position(|w| w == a) {
            rest.remove(i);
        } else {
            panic!(
                "expected `{a}`, as move_load and the constructors have it; found:\n{}",
                writers.join("\n")
            );
        }
    }
    assert!(
        rest.is_empty(),
        "the pane's load state is set outside move_load; send it an event \
         through move_load (thread_load.rs) instead:\n{}",
        rest.join("\n")
    );
}
