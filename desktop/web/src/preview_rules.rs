// What a local page previewed in the app may do (file.htmlpreview,
// file.runthem, review.media), with nothing of Chromium's in it so it's tested
// on any system. mac/preview.rs acts on them. The Swift app's
// LocalPreviewSchemeHandler and PreviewSandbox, moved onto Chromium:
//
// - The page is served from an address of its own, `https://<token>.preview.
//   threadbear.invalid/<page>`, which only that page's view answers, from its
//   `Site` (threadbear_core::local_preview): the page and the passive assets
//   it names in its folder, nothing else. `.invalid` never resolves, the
//   sealed context's proxy goes nowhere, and every other request from the
//   view is cancelled before it starts, so nothing reaches the network.
//   A token per view keeps two previews' files apart, as the Swift app's did.
// - Its main frame shows that page and nothing else: no link, form, refresh or
//   script takes it anywhere. A frame inside it may be its own origin (which
//   serves only the page and its assets) or the page's own about:blank or
//   srcdoc; data: and blob: frames only while scripts are off.
// - Every answer carries `policy` as its Content-Security-Policy, which a
//   page can't loosen.
// - Scripts are off unless Mike chose Run them for those exact bytes; then the
//   page is served only while its bytes match (`Site::page_digest`), and
//   `CLIPBOARD_GUARD` and `COPY_GUARD` run before its own.
use std::sync::Arc;
use threadbear_core::local_preview::Site;

/// The host every preview's token is under. `.invalid` is reserved never to
/// resolve (RFC 2606).
pub const PREVIEW_DOMAIN: &str = "preview.threadbear.invalid";

/// A page to preview: its site, and whether its scripts run.
#[derive(Clone)]
pub struct PreviewSite {
    pub site: Arc<Site>,
    pub scripts: bool,
    /// A live page in the transcript (live_pages.rs, the livePages
    /// experiment): its scripts run, and may start workers the page makes
    /// itself (blob:), as three.js does to decode a model. A dedicated worker
    /// has no DOM, clipboard or WebRTC, and its requests are the view's,
    /// held to `connect-src 'self'` and `may_request` like the page's.
    pub workers: bool,
    /// A page the app made itself (a design review's, threadbear_core's
    /// review_page.rs): a click on one of its own links under `ASK_PREFIX`
    /// is handed to the app (`asked`). Never with scripts.
    pub asks: bool,
    /// The view's own origin, `https://<token>.preview.threadbear.invalid`.
    pub origin: String,
}

impl PreviewSite {
    /// A fresh origin for `site`: each view gets its own.
    pub fn new(site: Arc<Site>, scripts: bool) -> PreviewSite {
        PreviewSite {
            site,
            scripts,
            workers: false,
            asks: false,
            origin: format!("https://{}.{PREVIEW_DOMAIN}", token()),
        }
    }

    /// A page the app made: scripts off, and its own links reach the app.
    pub fn made(site: Arc<Site>) -> PreviewSite {
        PreviewSite {
            asks: true,
            ..PreviewSite::new(site, false)
        }
    }

    /// A live page: scripts on, with workers of its own making.
    pub fn live(site: Arc<Site>) -> PreviewSite {
        PreviewSite {
            workers: true,
            ..PreviewSite::new(site, true)
        }
    }

    /// The page's address.
    pub fn page_url(&self) -> String {
        format!("{}/{}", self.origin, encode_path(&self.site.page))
    }
}

impl std::fmt::Debug for PreviewSite {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewSite")
            .field("page", &self.site.page)
            .field("scripts", &self.scripts)
            .field("workers", &self.workers)
            .field("asks", &self.asks)
            .field("origin", &self.origin)
            .finish()
    }
}

impl PartialEq for PreviewSite {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.site, &other.site)
            && self.scripts == other.scripts
            && self.workers == other.workers
            && self.asks == other.asks
            && self.origin == other.origin
    }
}

impl Eq for PreviewSite {}

/// 128 random bits as hex: the std hasher's keys are fresh random ones each
/// time it's made, and a counter keeps two made at once apart. Lowercase, as
/// a host is.
fn token() -> String {
    use std::hash::{BuildHasher as _, Hasher as _};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let n = COUNT.fetch_add(1, Ordering::Relaxed);
    let half = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(n);
        h.finish()
    };
    format!("{:016x}{:016x}", half(), half())
}

/// A file name for an address's path: each byte that isn't plainly safe
/// escaped, `/` kept.
pub fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The Content-Security-Policy every answer carries. Inline styles stay, for
/// mockups; everything else is the view's own origin, or data: and blob: made
/// on the page. A page running its scripts gets frames of its own origin
/// only, so a script can't make a data: or blob: frame to run in where the
/// guards might not be. Workers only for a live page (`PreviewSite::workers`),
/// and only ones it makes itself.
pub fn policy(scripts: bool, workers: bool) -> String {
    let frames = if scripts {
        "frame-src 'self'"
    } else {
        "frame-src 'self' data: blob:"
    };
    let workers = if scripts && workers {
        "worker-src blob:"
    } else {
        "worker-src 'none'"
    };
    [
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
        "connect-src 'self'",
        "form-action 'none'",
        frames,
        "base-uri 'none'",
        "object-src 'none'",
        workers,
    ]
    .join("; ")
}

/// The Permissions-Policy every answer carries: no clipboard, camera,
/// microphone, screen capture or the like for the page or any frame in it,
/// below the guards, in Chromium itself.
pub const PERMISSIONS: &str = "clipboard-read=(), clipboard-write=(), camera=(), microphone=(), display-capture=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), publickey-credentials-get=()";

/// Whether the view's frame may show `url`: the main frame its own page (a
/// jump to a place on it included) or a blank page; a frame inside it its own
/// origin or a blank or srcdoc page, and data: or blob: while scripts are off.
pub fn may_browse(url: &str, site: &PreviewSite, main: bool) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    if lower == "about:blank" {
        return true;
    }
    if main {
        let without_place = url.split('#').next().unwrap_or(url);
        return without_place == site.page_url();
    }
    if lower == "about:srcdoc" || own_path(url, &site.origin).is_some() {
        return true;
    }
    !site.scripts && (lower.starts_with("data:") || lower.starts_with("blob:"))
}

/// Where a page the app made keeps its links to the app, under its origin
/// (threadbear_core::review_page::ASK_PREFIX, with the path's slash).
pub const ASK_PREFIX: &str = "/_threadbear/";
/// The longest ask: a word and a couple of small numbers.
pub const MAX_ASK: usize = 48;

/// What a navigation of the view's main frame asks of the app, if it's a
/// link Mike clicked on a page the app made, to `ASK_PREFIX` on the page's
/// own origin: what follows the prefix, letters, digits and slashes only.
/// The navigation is cancelled like any other (`may_browse`); this only
/// says what to tell the app. Nothing for a page whose scripts run (it
/// could click its own links), a frame inside the page, a navigation with
/// no click behind it (a refresh the markup asks for), or an address with
/// a query, a fragment or an escape in it. What the words mean, and whether
/// they name anything real, is the app's to check.
pub fn asked(url: &str, site: &PreviewSite, main: bool, gesture: bool) -> Option<String> {
    if !site.asks || site.scripts || !main || !gesture || url.contains(['?', '#', '%']) {
        return None;
    }
    let rest = url
        .strip_prefix(site.origin.as_str())?
        .strip_prefix(ASK_PREFIX)?;
    (!rest.is_empty()
        && rest.len() <= MAX_ASK
        && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'/'))
    .then(|| rest.to_owned())
}

/// Whether a request from the view may start at all: its own origin, or
/// what's made on the page. Everything else is cancelled.
pub fn may_request(url: &str, site: &PreviewSite) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    own_path(url, &site.origin).is_some()
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower == "about:blank"
        || lower == "about:srcdoc"
}

/// The path `url` asks for on `origin`, decoded, without its query or
/// fragment, or None for another origin, a user or port in it, or an escape
/// that doesn't decode. What `Site::serve` is then asked for.
pub fn own_path(url: &str, origin: &str) -> Option<String> {
    let rest = url.strip_prefix(origin)?;
    // `https://<token>.preview.threadbear.invalid.evil` or `...:8443` aren't it.
    if !rest.starts_with('/') {
        return None;
    }
    let path = rest.split(['?', '#']).next().unwrap_or(rest);
    threadbear_core::local_preview::percent_decode(path)
}

/// Run in the page's own world in every frame before its scripts, while they
/// run: no Clipboard API, and no `execCommand('copy')` or `'cut'`, either of
/// which a script can use on any click to put what it read on the clipboard;
/// and no WebRTC, whose connections go round the proxy and the request
/// handlers (the Swift app turns it off in WebKit; Grok's review, 13 Nov).
/// Not configurable once set, and everything the wrapper uses is taken before
/// the page's scripts can replace it.
pub const CLIPBOARD_GUARD: &str = r#"(() => {
  try { delete Navigator.prototype.clipboard; } catch (_) {}
  try { Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: false }); } catch (_) {}
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCIceCandidate', 'RTCSessionDescription']) {
    try { delete globalThis[name]; } catch (_) {}
    try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch (_) {}
  }
  // No print dialog over the app (the second review of live pages, 19 Nov).
  try { Object.defineProperty(globalThis, 'print', { value: () => {}, writable: false, configurable: false }); } catch (_) {}
  const exec = Document.prototype.execCommand;
  const apply = Reflect.apply, toString = String, lower = String.prototype.toLowerCase;
  Object.defineProperty(Document.prototype, 'execCommand', {
    value: function (command, showUI, value) {
      const name = toString(command);
      const key = apply(lower, name, []);
      if (key === 'copy' || key === 'cut') return false;
      return apply(exec, this, arguments.length > 2 ? [name, showUI, value] : arguments.length > 1 ? [name, showUI] : [name]);
    },
    writable: false, configurable: false,
  });
})();"#;

/// Run in a world of its own in every frame, first, while the page's scripts
/// run (so the page can't reach these listeners): nothing is dragged or
/// copied out of the page, as a script can read the assets the page names
/// and hand them to a drag or a copy, which go through the system rather
/// than the network.
pub const COPY_GUARD: &str = r#"(() => {
  for (const type of ['dragstart', 'copy', 'cut']) {
    addEventListener(type, (e) => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
  }
})();"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(scripts: bool) -> PreviewSite {
        let dir =
            std::env::temp_dir().join(format!("preview-rules-{}-{}", std::process::id(), token()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("my page.html"), "<p>hi</p>").unwrap();
        let site = Site::new(&dir.join("my page.html"), None);
        #[cfg(unix)]
        let site = site.expect("a site");
        #[cfg(not(unix))]
        let site: Site = match site {
            Some(s) => s,
            None => panic!("no sites off unix"),
        };
        PreviewSite::new(Arc::new(site), scripts)
    }

    #[cfg(unix)]
    #[test]
    fn each_view_has_its_own_origin() {
        let (a, b) = (preview(false), preview(false));
        assert_ne!(a.origin, b.origin);
        assert!(
            a.origin.starts_with("https://") && a.origin.ends_with(".preview.threadbear.invalid")
        );
        assert_eq!(a.page_url(), format!("{}/my%20page.html", a.origin));
    }

    #[cfg(unix)]
    #[test]
    fn the_main_frame_shows_its_page_and_nothing_else() {
        let p = preview(false);
        assert!(may_browse(&p.page_url(), &p, true));
        assert!(
            may_browse(&format!("{}#section", p.page_url()), &p, true),
            "a jump to a place on it"
        );
        assert!(may_browse("about:blank", &p, true));
        for away in [
            "https://example.com/",
            "file:///etc/passwd",
            "data:text/html,hi",
            &format!("{}/other.html", p.origin),
            &format!("{}?x=1", p.page_url()),
            "javascript:alert(1)",
            &format!("{}.evil.com/my%20page.html", p.origin),
        ] {
            assert!(!may_browse(away, &p, true), "{away}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn frames_inside_stay_on_its_origin() {
        let (off, on) = (preview(false), preview(true));
        assert!(may_browse(&format!("{}/pic.png", off.origin), &off, false));
        assert!(may_browse("about:srcdoc", &off, false));
        assert!(
            may_browse("data:text/html,x", &off, false),
            "scripts off: harmless"
        );
        assert!(
            !may_browse("data:text/html,x", &on, false),
            "scripts on: not a frame the guards might miss"
        );
        assert!(!may_browse("blob:https://x/1", &on, false));
        assert!(!may_browse("https://example.com/", &off, false));
        assert!(
            !may_browse(
                &format!("{}/x", on.origin.replace("https://", "https://a")),
                &on,
                false
            ),
            "another token"
        );
    }

    #[cfg(unix)]
    #[test]
    fn requests_stay_on_its_origin() {
        let p = preview(false);
        assert!(may_request(&format!("{}/a/b.png?v=1", p.origin), &p));
        assert!(may_request("data:image/png;base64,AA", &p));
        for away in [
            "https://example.com/x.png",
            "http://127.0.0.1:9/",
            "ws://x/",
            "file:///etc/hosts",
            &format!("{}:443/x", p.origin),
            &format!("{}.x/y", p.origin),
            "chrome://settings",
        ] {
            assert!(!may_request(away, &p), "{away}");
        }
    }

    #[test]
    fn paths_are_decoded_and_cut() {
        let origin = "https://abc.preview.threadbear.invalid";
        assert_eq!(
            own_path(&format!("{origin}/my%20pic.png?v=2#x"), origin).as_deref(),
            Some("/my pic.png")
        );
        assert_eq!(
            own_path(&format!("{origin}/a%00.png"), origin).as_deref(),
            Some("/a\0.png"),
            "decoded, for the site to refuse"
        );
        assert_eq!(own_path(&format!("{origin}/bad%zz.png"), origin), None);
        assert_eq!(own_path(&format!("{origin}.evil/x.png"), origin), None);
        assert_eq!(own_path(&format!("{origin}:8443/x.png"), origin), None);
        assert_eq!(
            own_path("https://other.preview.threadbear.invalid/x.png", origin),
            None
        );
    }

    #[test]
    fn the_policy_keeps_frames_of_its_own_while_scripts_run() {
        assert!(
            policy(true, false).contains("frame-src 'self';")
                || policy(true, false).contains("frame-src 'self'")
        );
        assert!(!policy(true, false).contains("frame-src 'self' data:"));
        assert!(policy(false, false).contains("frame-src 'self' data: blob:"));
        // Workers only for a live page running its scripts, and only blob: ones.
        assert!(policy(true, false).contains("worker-src 'none'"));
        assert!(policy(false, true).contains("worker-src 'none'"));
        assert!(
            policy(true, true).contains("worker-src blob:")
                && !policy(true, true).contains("worker-src 'self'")
        );
        for both in [policy(true, false), policy(false, false)] {
            assert!(
                both.contains("connect-src 'self'")
                    && both.contains("form-action 'none'")
                    && both.contains("base-uri 'none'")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn only_a_click_on_a_made_pages_own_link_asks_the_app() {
        let made = PreviewSite::made(preview(false).site);
        assert!(made.asks && !made.scripts && !made.workers);
        let at = |rest: &str| format!("{}{rest}", made.origin);
        assert_eq!(
            asked(&at("/_threadbear/pick/0"), &made, true, true).as_deref(),
            Some("pick/0")
        );
        assert_eq!(
            asked(&at("/_threadbear/open/11/7"), &made, true, true).as_deref(),
            Some("open/11/7")
        );
        // The link goes nowhere either way: it isn't the page.
        assert!(!may_browse(&at("/_threadbear/pick/0"), &made, true));
        // Not without a click, nor from a frame inside the page.
        assert_eq!(asked(&at("/_threadbear/pick/0"), &made, true, false), None);
        assert_eq!(asked(&at("/_threadbear/pick/0"), &made, false, true), None);
        // Only plain words under the prefix, on its own origin.
        for odd in [
            "/_threadbear/",
            "/_threadbear/pick/0?x=1",
            "/_threadbear/pick/0#top",
            "/_threadbear/pick/%30",
            "/_threadbear/a.b",
            "/_threadbear/a b",
            "/_threadbear/../x",
            "/threadbear/pick/0",
            "/x/_threadbear/pick/0",
            "/my%20page.html",
        ] {
            assert_eq!(asked(&at(odd), &made, true, true), None, "{odd}");
        }
        assert_eq!(
            asked(
                &at(&format!("/_threadbear/{}", "a".repeat(MAX_ASK + 1))),
                &made,
                true,
                true
            ),
            None
        );
        assert_eq!(
            asked(
                &format!("{}.evil/_threadbear/pick/0", made.origin),
                &made,
                true,
                true
            ),
            None
        );
        assert_eq!(
            asked(
                "https://other.preview.threadbear.invalid/_threadbear/pick/0",
                &made,
                true,
                true
            ),
            None
        );
        // A page that isn't the app's own never asks, with its scripts off
        // or on, and one made to ask can't with scripts.
        for other in [
            preview(false),
            preview(true),
            PreviewSite {
                scripts: true,
                ..PreviewSite::made(preview(false).site)
            },
        ] {
            let url = format!("{}/_threadbear/pick/0", other.origin);
            assert_eq!(asked(&url, &other, true, true), None);
        }
    }

    #[test]
    fn the_ask_prefix_is_the_one_the_page_writes() {
        assert_eq!(
            ASK_PREFIX,
            format!("/{}", threadbear_core::review_page::ASK_PREFIX)
        );
    }

    #[test]
    fn names_are_escaped_in_the_address() {
        assert_eq!(encode_path("a b/c#d?.html"), "a%20b/c%23d%3F.html");
        assert_eq!(encode_path("é.html"), "%C3%A9.html");
    }
}
