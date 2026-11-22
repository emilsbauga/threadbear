// A design review as a page in the side pane (the reviewPage experiment):
// the agent's lead, then each option with its words at the thread's reading
// size and its pictures under them, in place of the review window's narrow
// column. Mike, 20 Nov 2026: he went into the window to see the pictures and
// back out to the thread to read about them, as the window drew each
// option's words at 12pt grey in a column 270pt wide.
//
// This makes the page's HTML from the review, with nothing of GPUI or
// Chromium in it so it's tested on any system. desktop/gpui/src/review_pane.rs
// shows it in the pane's sealed page view (web_panels.rs), with its scripts
// off, so the page can't change itself or tell the app anything except by a
// link Mike clicks: a tick or a picture is a link under `ASK_PREFIX` on the
// page's own origin, which the view never follows and hands to the app
// (threadbear_web::preview_rules::asked). `ask` reads one back, and takes
// nothing the review doesn't have.
use crate::reducer::{DesignReview, ImageRef, ReviewOption, ReviewShot};
use crate::review::{inline_markdown, InlineRun};

/// The page's name in its site. No file of this name is read: the site
/// answers it with the document made here (`local_preview::Site::made`).
pub const PAGE_NAME: &str = "threadbear-review.html";
/// Where the page's own links to the app start, under its origin.
pub const ASK_PREFIX: &str = "_threadbear/";
/// The font's files as the page names them: `<FONT_PREFIX><weight>.otf`.
pub const FONT_PREFIX: &str = "threadbear-font-";

/// How wide the pane opens for a review: room for words and a picture, or
/// for a wide design (a desktop app's mockup) more, so Mike doesn't drag it
/// out each time (20 Nov 2026). The transcript keeps its own least width
/// whatever this says.
pub const REGULAR_WIDTH: f32 = 640.;
pub const WIDE_WIDTH: f32 = 920.;
/// A picture this many pixels across or more, wider than it's tall, is a
/// wide design.
const WIDE_PICTURE: i64 = 1000;

/// The pane's width for `review`: wide if any of its pictures is a wide design.
pub fn pane_width(review: &DesignReview) -> f32 {
    let wide = review
        .options
        .iter()
        .flat_map(ReviewOption::all_shots)
        .any(|shot| match (shot.image.width, shot.image.height) {
            (Some(w), Some(h)) => w >= WIDE_PICTURE && w > h,
            _ => false,
        });
    if wide {
        WIDE_WIDTH
    } else {
        REGULAR_WIDTH
    }
}

/// What a click in the page asks of the app.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ask {
    /// Tick or untick the option at this index.
    Pick(usize),
    /// Show this option's shot full size.
    Open(usize, usize),
    /// Open the page's link of this number (`Page::links`).
    Link(usize),
}

/// The ask a clicked link names, as the view hands it over (what follows
/// `ASK_PREFIX`), if it's one this page could have made: an option and shot
/// the review has, an option that can be picked, a link the page has.
pub fn ask(rest: &str, review: &DesignReview, links: usize) -> Option<Ask> {
    let mut parts = rest.split('/');
    let (what, first, second) = (parts.next()?, parts.next(), parts.next());
    if parts.next().is_some() {
        return None;
    }
    // Digits only, and few: a number the page wrote.
    let number = |part: Option<&str>| {
        part.filter(|p| !p.is_empty() && p.len() <= 4 && p.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|p| p.parse::<usize>().ok())
    };
    match (what, number(first), second) {
        ("pick", Some(option), None) => review
            .options
            .get(option)
            .filter(|o| !o.reference && review.is_pending())
            .map(|_| Ask::Pick(option)),
        ("open", Some(option), Some(_)) => {
            let shot = number(second)?;
            (shot < review.options.get(option)?.shot_count()).then_some(Ask::Open(option, shot))
        }
        ("link", Some(link), None) => (link < links).then_some(Ask::Link(link)),
        _ => None,
    }
}

/// A script of the app's own that ticks or unticks options on the page as
/// it stands: each option's index and whether it's ticked now. The page's
/// own scripts are off, so the app runs this through the view's DevTools
/// (web_panels::run_in_made_page). Loading the page again for a tick took
/// it back to its top, away from the option just ticked (the first build
/// did, 20 Nov 2026). Only digits and true or false go into it; it answers
/// true when every option was on the page.
pub fn tick_script(changes: &[(usize, bool)]) -> String {
    let list = changes
        .iter()
        .map(|(option, on)| format!("[{option},{on}]"))
        .collect::<Vec<_>>()
        .join(",");
    format!("(()=>{{let ok=true;for(const [i,on] of [{list}]){{const s=document.getElementById('o'+i);if(s){{s.classList.toggle('picked',on)}}else{{ok=false}}}}return ok}})()")
}

/// The app's look, for the page to match the thread beside it.
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub dark: bool,
    /// CSS colours.
    pub background: String,
    pub text: String,
    pub strong: String,
    pub secondary: String,
    pub hairline: String,
    pub fill: String,
    pub accent: String,
    pub star: String,
    pub link: String,
    /// The CSS font-family after the app's own font, if it has one.
    pub font_family: String,
    /// The weights of the app's own font the site serves (`FONT_PREFIX`).
    pub font_weights: Vec<u16>,
    /// The thread's text size and line height, zoomed.
    pub size: f32,
    pub line: f32,
}

/// The page made for a review.
#[derive(Clone, Debug, PartialEq)]
pub struct Page {
    pub html: String,
    /// The addresses its notes link to, by the number in each link's ask.
    pub links: Vec<String>,
    /// The pictures and clips on it, as paths under the review's folder:
    /// all its site reads from there (`Site::made`).
    pub assets: Vec<String>,
}

/// The review's page. `picked` are the options ticked now; `source` gives a
/// picture's or clip's path under the review's folder, with `/` between its
/// parts, or None for one that isn't there, which the page says in its place.
pub fn page(
    review: &DesignReview,
    picked: &[String],
    look: &Look,
    source: &dyn Fn(&ImageRef) -> Option<String>,
) -> Page {
    let mut links: Vec<String> = Vec::new();
    let mut assets: Vec<String> = Vec::new();
    // Each file once, in the order the page has them.
    let mut placed = |image: &ImageRef| {
        let path = source(image)?;
        if !assets.contains(&path) {
            assets.push(path.clone());
        }
        Some(url_path(&path))
    };
    let mut body = String::new();
    if let Some(note) = review.note.as_deref().filter(|n| !n.trim().is_empty()) {
        body.push_str("<div class=\"lead\">");
        body.push_str(&note_html(note, &mut links));
        body.push_str("</div>");
    }
    let pending = review.is_pending();
    for (index, option) in review.options.iter().enumerate() {
        let is_picked = picked.contains(&option.id);
        let mut classes = vec!["opt"];
        if is_picked {
            classes.push("picked");
        }
        if option.reference {
            classes.push("ref");
        }
        body.push_str(&format!(
            "<section id=\"o{index}\" class=\"{}\"><h2>",
            classes.join(" ")
        ));
        // A tick to click while it can still be answered, the tick alone on
        // what was picked once it's over, and nothing on a reference.
        if !option.reference {
            if pending {
                body.push_str(&format!(
                    "<a class=\"pick\" href=\"{ASK_PREFIX}pick/{index}\" title=\"{}\"></a>",
                    escape(&format!("Pick {}", option.id))
                ));
            } else if is_picked {
                body.push_str("<span class=\"pick\"></span>");
            }
        }
        body.push_str(&format!("<span>{}</span>", escape(&option.title)));
        if review.recommended.as_deref() == Some(option.id.as_str()) {
            body.push_str("<span class=\"rec\">Recommended</span>");
        }
        body.push_str("</h2>");
        if let Some(note) = option.note.as_deref().filter(|n| !n.trim().is_empty()) {
            body.push_str(&note_html(note, &mut links));
        }
        for (shot_index, shot) in option.all_shots().iter().enumerate() {
            body.push_str(&shot_html(index, shot_index, shot, &mut placed));
        }
        body.push_str("</section>");
    }
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{}</title><style>{}</style></head><body><main>{body}</main></body></html>",
        escape(&review.title),
        style(look)
    );
    Page {
        html,
        links,
        assets,
    }
}

/// A file's path as an address on the page: every byte that isn't plainly
/// safe escaped, `/` kept (threadbear_web's `encode_path`, which this crate
/// can't reach).
fn url_path(path: &str) -> String {
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

/// One shot: its picture (a clip plays, quietly, on a loop; a page shows its
/// still), which a click opens full size, and its title under it.
fn shot_html(
    option: usize,
    index: usize,
    shot: &ReviewShot,
    source: &mut dyn FnMut(&ImageRef) -> Option<String>,
) -> String {
    let video = shot
        .media
        .as_ref()
        .filter(|m| m.media_type.starts_with("video/"));
    let still = source(&shot.image);
    let tall = matches!((shot.image.width, shot.image.height), (Some(w), Some(h)) if h > w);
    let class = if tall { " class=\"tall\"" } else { "" };
    let size = match (shot.image.width, shot.image.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => format!(" width=\"{w}\" height=\"{h}\""),
        _ => String::new(),
    };
    let inner = match (video.and_then(source), &still) {
        (Some(clip), _) => {
            let poster = still
                .as_ref()
                .map(|s| format!(" poster=\"{}\"", escape(s)))
                .unwrap_or_default();
            format!(
                "<video src=\"{}\"{poster}{class}{size} muted loop autoplay playsinline></video>",
                escape(&clip)
            )
        }
        (None, Some(still)) => format!("<img src=\"{}\"{class}{size} alt=\"\">", escape(still)),
        (None, None) => {
            return "<figure><div class=\"gone\">This picture isn't here any more.</div></figure>"
                .to_owned()
        }
    };
    let caption = shot
        .title
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(|t| format!("<figcaption>{}</figcaption>", escape(t)))
        .unwrap_or_default();
    format!("<figure><a href=\"{ASK_PREFIX}open/{option}/{index}\">{inner}</a>{caption}</figure>")
}

/// A note as HTML: paragraphs where it leaves a blank line, a list where
/// its lines start with "- " or "* ", and inline markdown (bold, italic,
/// code, links) in each.
fn note_html(note: &str, links: &mut Vec<String>) -> String {
    let mut out = String::new();
    for block in note
        .replace("\r\n", "\n")
        .split("\n\n")
        .map(str::trim)
        .filter(|b| !b.is_empty())
    {
        let lines: Vec<&str> = block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        let item = |line: &str| {
            line.strip_prefix("- ")
                .or_else(|| line.strip_prefix("* "))
                .map(str::to_owned)
        };
        if lines.iter().all(|l| item(l).is_some()) {
            out.push_str("<ul>");
            for line in &lines {
                out.push_str(&format!(
                    "<li>{}</li>",
                    inline_html(&item(line).unwrap_or_default(), links)
                ));
            }
            out.push_str("</ul>");
        } else {
            out.push_str(&format!(
                "<p>{}</p>",
                lines
                    .iter()
                    .map(|l| inline_html(l, links))
                    .collect::<Vec<_>>()
                    .join("<br>")
            ));
        }
    }
    out
}

fn inline_html(text: &str, links: &mut Vec<String>) -> String {
    let mut out = String::new();
    for InlineRun {
        text,
        bold,
        italic,
        code,
        link,
    } in inline_markdown(text)
    {
        let mut piece = escape(&text);
        if code {
            piece = format!("<code>{piece}</code>");
        }
        if italic {
            piece = format!("<em>{piece}</em>");
        }
        if bold {
            piece = format!("<strong>{piece}</strong>");
        }
        if let Some(address) = link {
            // One number an address, however many runs its words are in.
            let number = links
                .iter()
                .position(|l| l.as_str() == &*address)
                .unwrap_or_else(|| {
                    links.push(address.to_string());
                    links.len() - 1
                });
            piece = format!("<a class=\"link\" href=\"{ASK_PREFIX}link/{number}\">{piece}</a>");
        }
        out.push_str(&piece);
    }
    out
}

/// Text for HTML, in an element or a quoted attribute.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A colour or font name is the app's own, but it goes into a stylesheet:
/// nothing that could end a rule or the style element.
fn css_value(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, ';' | '{' | '}' | '<' | '>' | '\\' | '\n' | '\r'))
        .collect()
}

fn style(look: &Look) -> String {
    let v = |s: &str| css_value(s);
    let mut css = String::new();
    for weight in &look.font_weights {
        css.push_str(&format!("@font-face{{font-family:\"Threadbear\";font-weight:{weight};src:url({FONT_PREFIX}{weight}.otf)}}"));
    }
    let family = if look.font_weights.is_empty() {
        v(&look.font_family)
    } else {
        format!("\"Threadbear\",{}", v(&look.font_family))
    };
    let (size, line) = (look.size, look.line);
    let scheme = if look.dark { "dark" } else { "light" };
    css.push_str(&format!(
        ":root{{color-scheme:{scheme}}}*{{box-sizing:border-box}}html{{background:{bg}}}\
body{{margin:0;padding:{pad}px {side}px {foot}px;font:400 {size}px/{line}px {family};color:{text};-webkit-font-smoothing:antialiased}}\
main{{max-width:1100px;margin:0 auto}}p{{margin:0 0 {gap}px}}ul{{margin:0 0 {gap}px;padding-left:{indent}px}}li{{margin-bottom:{li}px}}\
.lead{{font-size:{lead}px;line-height:{lead_line}px}}strong{{font-weight:600;color:{strong}}}\
code{{font:{code}px ui-monospace,Menlo,monospace;background:{fill};border-radius:4px;padding:1px 4px}}\
a.link{{color:{link};text-decoration:none;cursor:pointer}}\
section{{padding-top:{section}px}}\
h2{{display:flex;align-items:center;flex-wrap:wrap;gap:{h2gap}px;margin:0 0 {h2foot}px;font-size:{h2}px;line-height:{h2line}px;font-weight:600;color:{strong}}}\
.pick{{flex:none;display:block;width:{box}px;height:{box}px;border-radius:{radius}px;border:1.4px solid {secondary};cursor:pointer}}\
.picked .pick{{background:{accent};border-color:{accent};position:relative}}\
.picked .pick::after{{content:\"\";position:absolute;left:22%;top:24%;width:46%;height:24%;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg)}}\
.rec{{display:inline-flex;align-items:center;gap:4px;font-size:{small}px;font-weight:400;color:{secondary}}}.rec::before{{content:\"\\2605\";color:{star}}}\
figure{{margin:{fig}px 0 0}}figure a{{display:block;cursor:zoom-in}}\
img,video{{display:block;max-width:100%;height:auto;border-radius:8px;border:1px solid {hairline}}}\
img.tall,video.tall{{max-height:80vh;width:auto}}\
figcaption,.gone{{font-size:{small}px;line-height:{small_line}px;color:{secondary};margin-top:6px}}",
        bg = v(&look.background),
        text = v(&look.text),
        strong = v(&look.strong),
        secondary = v(&look.secondary),
        hairline = v(&look.hairline),
        fill = v(&look.fill),
        accent = v(&look.accent),
        star = v(&look.star),
        link = v(&look.link),
        pad = px(size * 1.2),
        side = px(size * 1.5),
        foot = px(size * 3.),
        gap = px(size * 0.8),
        indent = px(size * 1.4),
        li = px(size * 0.4),
        lead = px(size * 16. / 15.),
        lead_line = px(line * 25. / 23.),
        code = px(size * 13. / 15.),
        section = px(size * 1.8),
        h2 = px(size * 19. / 15.),
        h2line = px(line * 27. / 23.),
        h2gap = px(size * 0.7),
        h2foot = px(size * 0.4),
        box = px(size * 1.2),
        radius = px(size * 0.3),
        small = px(size * 12. / 15.),
        small_line = px(line * 17. / 23.),
        fig = px(size * 0.9),
        size = px(size),
        line = px(line),
    ));
    css
}

/// A length to a tenth of a pixel, with no trailing ".0".
fn px(value: f32) -> String {
    let rounded = (value * 10.).round() / 10.;
    if (rounded - rounded.round()).abs() < 0.05 {
        format!("{}", rounded.round() as i64)
    } else {
        format!("{rounded:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn look() -> Look {
        Look {
            dark: true,
            background: "#1e1e1e".into(),
            text: "rgba(255,255,255,0.85)".into(),
            strong: "#fff".into(),
            secondary: "rgba(255,255,255,0.55)".into(),
            hairline: "rgba(255,255,255,0.1)".into(),
            fill: "rgba(255,255,255,0.06)".into(),
            accent: "#0a85ff".into(),
            star: "#e5b93c".into(),
            link: "#419cff".into(),
            font_family: "-apple-system,sans-serif".into(),
            font_weights: vec![400, 600],
            size: 15.,
            line: 23.,
        }
    }

    fn review(status: &str) -> DesignReview {
        DesignReview::decode(&json!({
            "id": "r1", "title": "A <rail>, three ways", "note": "**What it solves:** hidden tools.\n\nSee [the notes](https://example.com/a?b=1&c=2).",
            "recommended": "A", "status": status, "revision": 1, "createdAt": "2026-11-20T00:00:00Z", "updatedAt": "2026-11-20T00:00:00Z", "draft": { "notes": {} },
            "options": [
                { "id": "A", "title": "Tools, like Canva", "note": "- One click away\n- Familiar", "image": { "path": "/r/a.png", "mediaType": "image/png", "width": 1600, "height": 950 } },
                { "id": "B", "title": "Three \"steps\"", "image": { "path": "/r/b.png", "mediaType": "image/png", "width": 390, "height": 844 },
                  "shots": [
                      { "title": "Overview", "image": { "path": "/r/b.png", "mediaType": "image/png", "width": 390, "height": 844 } },
                      { "title": "Mid-drag", "image": { "path": "/r/b2.png", "mediaType": "image/png" }, "media": { "path": "/r/b2.mp4", "mediaType": "video/mp4" } }
                  ] },
                { "id": "T", "title": "Today", "reference": true, "image": { "path": "/elsewhere/t.png", "mediaType": "image/png" } }
            ]
        }))
        .expect("the review decodes")
    }

    fn under_r(image: &ImageRef) -> Option<String> {
        image.path.strip_prefix("/r/").map(str::to_owned)
    }

    #[test]
    fn the_page_has_each_option_with_its_words_and_pictures() {
        let page = page(&review("pending"), &["A".to_owned()], &look(), &under_r);
        let html = &page.html;
        assert!(html.contains("<title>A &lt;rail&gt;, three ways</title>"));
        assert!(html.contains("<strong>What it solves:</strong> hidden tools."));
        assert!(html.contains("<section id=\"o0\" class=\"opt picked\">"));
        assert!(html.contains("<a class=\"pick\" href=\"_threadbear/pick/0\" title=\"Pick A\"></a><span>Tools, like Canva</span><span class=\"rec\">Recommended</span>"));
        assert!(html.contains("<ul><li>One click away</li><li>Familiar</li></ul>"));
        assert!(html.contains("<a href=\"_threadbear/open/0/0\"><img src=\"a.png\" width=\"1600\" height=\"950\" alt=\"\"></a>"));
        assert!(html.contains("<span>Three &quot;steps&quot;</span>"));
        assert!(html.contains("<img src=\"b.png\" class=\"tall\" width=\"390\" height=\"844\" alt=\"\"></a><figcaption>Overview</figcaption>"));
        assert!(html.contains("<a href=\"_threadbear/open/1/1\"><video src=\"b2.mp4\" poster=\"b2.png\" muted loop autoplay playsinline></video></a><figcaption>Mid-drag</figcaption>"));
        // What its site may read: the pictures and the clip, each once, and
        // not the reference's, which isn't in the folder.
        assert_eq!(page.assets, ["a.png", "b.png", "b2.png", "b2.mp4"]);
    }

    #[test]
    fn a_files_name_is_escaped_in_its_address_and_plain_in_what_the_site_reads() {
        let page = page(&review("pending"), &[], &look(), &|image| {
            image
                .path
                .strip_prefix("/r/")
                .map(|name| format!("my shots/{name}"))
        });
        assert!(page.html.contains("<img src=\"my%20shots/a.png\""));
        assert_eq!(page.assets[0], "my shots/a.png");
    }

    #[test]
    fn a_reference_has_no_tick_and_a_missing_picture_says_so() {
        let page = page(&review("pending"), &[], &look(), &under_r);
        let today = page
            .html
            .split("<section id=\"o2\"")
            .nth(1)
            .expect("the reference's section");
        assert!(today.starts_with(" class=\"opt ref\"><h2><span>Today</span></h2>"));
        assert!(today.contains("This picture isn't here any more."));
        assert!(!today.contains("_threadbear/pick"));
    }

    #[test]
    fn an_answered_review_keeps_its_ticks_but_takes_no_more() {
        let page = page(&review("answered"), &["B".to_owned()], &look(), &under_r);
        assert!(!page.html.contains("_threadbear/pick"));
        assert!(page
            .html
            .contains("<section id=\"o1\" class=\"opt picked\"><h2><span class=\"pick\"></span>"));
        assert!(page
            .html
            .contains("<section id=\"o0\" class=\"opt\"><h2><span>Tools, like Canva</span>"));
    }

    #[test]
    fn a_notes_link_is_an_ask_with_its_address_kept_beside_the_page() {
        let page = page(&review("pending"), &[], &look(), &under_r);
        assert_eq!(page.links, vec!["https://example.com/a?b=1&c=2".to_owned()]);
        assert!(page
            .html
            .contains("<a class=\"link\" href=\"_threadbear/link/0\">the notes</a>"));
        assert!(!page.html.contains("example.com"));
    }

    #[test]
    fn nothing_an_agent_wrote_reaches_the_page_as_markup() {
        let mut r = review("pending");
        r.title = "</title><script>alert(1)</script>".into();
        r.note = Some("<img src=x onerror=alert(1)> `</style>` **<b>**".into());
        r.options[0].title = "\"><script>".into();
        r.options[0].id = "\"><script>".into();
        let page = page(&r, &[], &look(), &|_| {
            Some("x\" onerror=\"alert(1).png".to_owned())
        });
        assert!(!page.html.contains("<script"));
        assert!(!page.html.contains("<img src=x"));
        assert!(!page.html.contains("\" onerror"));
        assert!(page
            .html
            .contains("<img src=\"x%22%20onerror%3D%22alert%281%29.png\""));
        assert_eq!(page.html.matches("</style>").count(), 1);
        assert_eq!(page.html.matches("</title>").count(), 1);
    }

    #[test]
    fn the_looks_own_words_cant_end_the_stylesheet() {
        let mut l = look();
        l.font_family = "x;}</style><script>".into();
        l.text = "red;}body{display:none".into();
        let page = page(&review("pending"), &[], &l, &under_r);
        assert!(!page.html.contains("<script"));
        assert!(!page.html.contains("body{display:none"));
    }

    #[test]
    fn the_fonts_are_the_sites_own_files() {
        let page = page(&review("pending"), &[], &look(), &under_r);
        assert!(page.html.contains("@font-face{font-family:\"Threadbear\";font-weight:400;src:url(threadbear-font-400.otf)}"));
        assert!(page
            .html
            .contains("font:400 15px/23px \"Threadbear\",-apple-system,sans-serif"));
        let mut plain = look();
        plain.font_weights.clear();
        assert!(!super::page(&review("pending"), &[], &plain, &under_r)
            .html
            .contains("@font-face"));
    }

    #[test]
    fn an_ask_is_only_what_the_page_could_have_made() {
        let r = review("pending");
        assert_eq!(ask("pick/0", &r, 1), Some(Ask::Pick(0)));
        assert_eq!(ask("open/1/1", &r, 1), Some(Ask::Open(1, 1)));
        assert_eq!(ask("open/0/0", &r, 1), Some(Ask::Open(0, 0)));
        assert_eq!(ask("link/0", &r, 1), Some(Ask::Link(0)));
        // A reference can't be picked, nor an option or shot that isn't there.
        assert_eq!(ask("pick/2", &r, 1), None);
        assert_eq!(ask("pick/3", &r, 1), None);
        assert_eq!(ask("open/0/1", &r, 1), None);
        assert_eq!(ask("open/1/2", &r, 1), None);
        assert_eq!(ask("link/1", &r, 1), None);
        for odd in [
            "",
            "pick",
            "pick/",
            "pick/-1",
            "pick/0/0",
            "pick/00000",
            "pick/0x1",
            "open/0",
            "open/0/0/0",
            "open/a/b",
            "run/0",
            "pick/0?x",
            "../pick/0",
            "pick/%30",
        ] {
            assert_eq!(ask(odd, &r, 1), None, "{odd}");
        }
        // Once it's answered there's nothing to pick.
        assert_eq!(ask("pick/0", &review("answered"), 1), None);
        assert_eq!(
            ask("open/0/0", &review("answered"), 1),
            Some(Ask::Open(0, 0))
        );
    }

    #[test]
    fn the_tick_script_names_options_by_number_only() {
        assert_eq!(tick_script(&[(1, true), (3, false)]), "(()=>{let ok=true;for(const [i,on] of [[1,true],[3,false]]){const s=document.getElementById('o'+i);if(s){s.classList.toggle('picked',on)}else{ok=false}}return ok})()");
        // The sections it looks for are the ones the page has.
        assert!(page(&review("pending"), &[], &look(), &under_r)
            .html
            .contains("<section id=\"o1\" class=\"opt\">"));
    }

    #[test]
    fn a_wide_design_opens_the_pane_wide() {
        let mut r = review("pending");
        assert_eq!(pane_width(&r), WIDE_WIDTH);
        r.options[0].image.width = Some(800);
        assert_eq!(pane_width(&r), REGULAR_WIDTH);
        // A tall picture is never a wide design, however many pixels across.
        r.options[0].image = ImageRef {
            path: "/r/a.png".into(),
            media_type: "image/png".into(),
            width: Some(1290),
            height: Some(2796),
        };
        assert_eq!(pane_width(&r), REGULAR_WIDTH);
    }

    #[test]
    fn lengths_have_no_trailing_zero() {
        assert_eq!(px(15.), "15");
        assert_eq!(px(16.5), "16.5");
        assert_eq!(px(12.04), "12");
    }
}
