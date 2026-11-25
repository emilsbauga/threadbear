//! The SVG drawing process (src/svg_worker.rs), run as the app runs it: this
//! binary started again with its argument, the SVG on stdin.
#![expect(
    clippy::unwrap_used,
    reason = "test helpers: a failure there is the test failing"
)]

use std::io::Write as _;
use std::process::{Command, Stdio};

fn draw(svg: &[u8], cap: Option<u64>) -> (Option<i32>, Vec<u8>) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_threadbear-gpui"));
    command
        .args(["--threadbear-draw-svg", "1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cap) = cap {
        command.env("THREADBEAR_SVG_TEST_CAP", cap.to_string());
    }
    let mut child = command.spawn().unwrap();
    child.stdin.take().unwrap().write_all(svg).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.code(), out.stdout)
}

#[test]
fn a_picture_is_drawn_and_sent_back() {
    let (code, answer) = draw(
        br#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>"#,
        None,
    );
    assert_eq!(code, Some(0));
    assert_eq!(&answer[..4], b"SVG1");
    // 20 x 10 drawn at twice the size, four bytes a pixel.
    assert_eq!(answer.len(), 16 + 40 * 20 * 4);
}

#[test]
fn what_isnt_an_svg_is_said_so() {
    let (code, answer) = draw(b"not an svg", None);
    assert_eq!(code, Some(0));
    assert_eq!(answer, b"BAD1");
    let (_, answer) = draw(
        br#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><text>@</text></svg>"#,
        None,
    );
    assert_eq!(answer, b"BIG1");
}

// One that takes more than its share ends there, quietly (exit 3, no
// abort for the system to report), and sends nothing back.
#[test]
fn a_picture_taking_more_than_its_share_ends_the_process() {
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="2048"><rect width="2048" height="2048"/></svg>"#;
    let (code, answer) = draw(svg, Some(1 << 20));
    assert_eq!(code, Some(3));
    assert!(answer.is_empty());
}
