// The live mark before a link to another thread in a reply
// (rich.threadlinkmarks; threadbear_core::link_marks says which state and
// where): a small copy of that thread's sidebar tile, with the sidebar's
// turning arc round it while it works, a small orange badge when it needs
// Mike, a red one if it failed and a tick once it's done. Mike picked this
// look from three mockups on 17 Nov 2026 (option C).
//
// It's drawn from the app's own copy of the thread as the reply draws, so it
// changes as that thread does: a thread's summary changing has the open
// transcript draw again. The arc turns by drawing its view again
// (spinner.rs's TurningArc, not layered: the arc layer is the sidebar's), as
// the running rows' spinners in a transcript already do, and only while the
// mark is on screen: one scrolled away isn't painted, so asks for nothing.
use crate::style;
use crate::tips::Tip as _;
use gpui_kit::base::text::{
    InlineElement, InlineRenderContext, MarkdownNode, MarkdownParseContext, MarkdownPlugin,
};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::ActiveTheme as _;
use gpui_kit::prelude::*;
use gpui_kit::*;
// The zoom-aware px (style.rs), in place of GPUI's.
use crate::style::px;
use threadbear_core::link_marks::{LinkMark, SCHEME};

/// The tile, a little smaller than the body text's capitals are tall, and
/// the room round it for the arc.
const TILE: f32 = 13.;
const RING: f32 = 19.;
/// Where the box's baseline sits from its top, so the tile centres on the
/// words' x-height as the reply buttons' pills do.
const BASELINE: f32 = 14.5;

/// The markdown plugin that draws `[\u{2060}](tbmark:<id>)` as the mark.
pub(crate) struct Marks;

#[derive(Clone)]
struct MarkRef {
    id: String,
}

impl MarkdownPlugin for Marks {
    fn name(&self) -> &str {
        "thread-link-mark"
    }

    fn parse(
        &self,
        node: &markdown::mdast::Node,
        _cx: &MarkdownParseContext<'_>,
    ) -> Option<MarkdownNode> {
        let markdown::mdast::Node::Link(link) = node else {
            return None;
        };
        let id = link.url.strip_prefix(SCHEME)?.to_owned();
        // Selected or copied, it's nothing: the thread's link after it is
        // what the words were.
        Some(
            MarkdownNode::new("thread-link-mark", MarkRef { id })
                .text("")
                .markdown(""),
        )
    }

    fn render_inline(
        &self,
        node: &MarkdownNode,
        _context: &InlineRenderContext,
        _window: &mut Window,
        cx: &mut App,
    ) -> Option<InlineElement> {
        let mark = node.data::<MarkRef>()?.clone();
        let app = cx
            .try_global::<crate::open_gate::GateNotices>()
            .and_then(|n| n.0.upgrade());
        // A thread that's gone since the reply was drawn: no mark.
        let Some((tile, state)) = app.as_ref().and_then(|a| {
            let t = a.read(cx);
            let thread = t.threads.get(&mark.id)?;
            Some((t.mini_tile(thread, TILE, cx), LinkMark::of(thread)))
        }) else {
            return Some(InlineElement::new(div().w(px(0.5)).h(px(1.))));
        };
        Some(InlineElement::new(render(&mark.id, tile, state, cx)).with_baseline(px(BASELINE)))
    }
}

/// The tile in its ring's room, with what it says over it.
fn render(id: &str, tile: AnyElement, state: LinkMark, cx: &App) -> impl IntoElement {
    let badge = |fill: Hsla, glyph: Option<&'static str>| {
        let behind = cx.theme().background;
        div()
            .absolute()
            .right(px(-1.))
            .bottom(px(-1.))
            .size(px(8.))
            .rounded_full()
            .bg(fill)
            // A hairline of the page behind it, so it reads as on the tile.
            .border_1()
            .border_color(behind)
            .flex()
            .items_center()
            .justify_center()
            .when_some(glyph, |d, g| d.child(crate::sidebar::icon(g, 5., behind)))
    };
    let over: Option<AnyElement> = match state {
        LinkMark::NeedsYou => Some(badge(style::needs_you(cx), None).into_any_element()),
        LinkMark::Failed => Some(badge(style::failed(cx), None).into_any_element()),
        LinkMark::Done => Some(badge(style::quiet_text(cx), Some("checkmark")).into_any_element()),
        LinkMark::Working | LinkMark::Idle => None,
    };
    div()
        .id(SharedString::from(format!("thread-link-mark-{id}")))
        .test_support()
        .relative()
        .flex_none()
        .size(px(RING))
        .mr(px(2.))
        .flex()
        .items_center()
        .justify_center()
        .child(div().relative().child(tile).children(over))
        .when(state == LinkMark::Working, |d| {
            d.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(crate::spinner::TurningArc::new(RING, style::accent(cx))),
            )
        })
        .tip(state.words())
}

/// For scripts: each thread link's mark in a reply, as "<id>: <state>", in
/// the order they're drawn. None when it has none.
#[cfg(feature = "automation")]
pub(crate) fn dump(text: &str, app: &crate::app::Threadbear) -> Option<Vec<String>> {
    let marked = threadbear_core::link_marks::with_marks(text, &|id| {
        threadbear_core::link_marks::resolve_in(id, app.threads.keys())
    });
    let mut out = Vec::new();
    let mut rest: &str = &marked;
    while let Some(at) = rest.find(SCHEME) {
        rest = &rest[at + SCHEME.len()..];
        let id = &rest[..rest.find(')').unwrap_or(rest.len())];
        if let Some(t) = app.threads.get(id) {
            out.push(format!("{id}: {}", LinkMark::of(t).words()));
        }
    }
    (!out.is_empty()).then_some(out)
}
