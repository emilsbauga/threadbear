// The hello cards: the first launch's setup, drawn over the window before
// the app, one small card per decision (Mike picked it on 17 Nov, after
// trying Capy's). What each card says and which show is
// threadbear_core::hello; this draws them and does what their buttons do,
// with what the app and the runner already have:
//
//   Your agents      the logins the runner found (`hello`/`accounts.updated`),
//                    Sign in… as the Usage panel's (header.rs), and another
//                    Claude login made the way the guide says: a claude-N
//                    folder in the runner's `accounts`, signed in from Terminal
//   Where threads    Settings' default folder (`settings.update`), and whether
//     start          GitHub's CLI is signed in (`gh auth status`, read once)
//   Phone            `devices.pair`'s code, drawn as Settings draws it, and
//                    `devices.list` every two seconds till a phone's paired
//   Worth turning on Code review and Keep the Mac awake (`settings.update`),
//                    the app's look, and Connectors opened once it's done;
//                    its Done opens a new thread, ready to type in
//
// Every button shows what it's doing at once: a sign-in or a pairing spins
// until it's there, a switch flips straight away (the runner's answer has the
// last word, `update_runner_settings`). Done, skipped or Esc, the cards don't
// come by themselves again (`tourSeen`, shared with the tour, so a Mac that
// finished the tour, or the Swift app's, skips them), and Finish setting up
// opens with what's left. Help > Set Up Threadbear brings them back.
use crate::a11y::A11yRole as _;
use crate::app::Threadbear;
use crate::push_button::PushButton;
use crate::style::{self, px};
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _, StyledExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use threadbear_core::devices::{DeviceList, Kind, Qr};
use threadbear_core::hello::{self as rules, AgentState, Card, Pose};
use threadbear_core::sign_in::SignInAccount;

const CARD_WIDTH: f32 = 470.;
const BEAR_HEIGHT: f32 = 104.;

/// The six bear pictures (docs/threadbear-design/sprites): the cards' big
/// pictures, so raster rather than the line glyphs the small places use.
fn bear(pose: Pose) -> Arc<Image> {
    static BEARS: OnceLock<Vec<Arc<Image>>> = OnceLock::new();
    let all = BEARS.get_or_init(|| {
        [
            &include_bytes!("../icons/bear/wave.png")[..],
            &include_bytes!("../icons/bear/sit.png")[..],
            &include_bytes!("../icons/bear/cub.png")[..],
            &include_bytes!("../icons/bear/sleep.png")[..],
            &include_bytes!("../icons/bear/patch.png")[..],
            &include_bytes!("../icons/bear/dizzy.png")[..],
        ]
        .into_iter()
        .map(|bytes| Arc::new(Image::from_bytes(ImageFormat::Png, bytes.to_vec())))
        .collect()
    });
    let i = match pose {
        Pose::Wave => 0,
        Pose::Sit => 1,
        Pose::Cub => 2,
        Pose::Sleep => 3,
        Pose::Patch => 4,
        Pose::Dizzy => 5,
    };
    all[i].clone()
}

/// Another Claude login on its way: the folder this app made for it, till
/// its sign-in has written an address.
struct Adding {
    id: String,
    dir: PathBuf,
}

#[derive(Default)]
pub(crate) struct HelloState {
    /// The card on show; None while the cards are away.
    at: Option<Card>,
    focus: Option<FocusHandle>,
    /// A login whose Sign in… opened Terminal, till it's signed in.
    signing: Option<String>,
    adding: Option<Adding>,
    /// Asks the runner about a pending sign-in every few seconds
    /// (accounts.recheck): its own sweep is ten minutes apart.
    sign_watch: Option<Task<()>>,
    /// GitHub's CLI: None till asked, then the account or "" for nobody.
    gh: Option<String>,
    // The Phone card.
    pairing: bool,
    qr: Option<Qr>,
    pair_error: Option<String>,
    /// The phones paired when the card came up, so a new one ticks it.
    phones_before: Option<Vec<String>>,
    devices: DeviceList,
    poll: Option<Task<()>>,
    /// Connectors, opened once the cards are done.
    open_connectors: bool,
}

impl Threadbear {
    /// Whether a phone can pair here: a backend that isn't this Mac only,
    /// as Finish setting up decides (setup_panel.rs).
    fn hello_can_pair(&self) -> bool {
        self.setup_checklist().items.iter().any(|(item, _)| *item == threadbear_core::tour::SetupItem::Phone)
    }

    fn hello_cards(&self) -> Vec<Card> {
        rules::cards(self.hello_can_pair())
    }

    /// The first launch (tour.rs's `tour_start_if_new`), and Help > Set Up
    /// Threadbear.
    pub(crate) fn hello_start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tour.tour.is_on() {
            self.tour_finish(cx);
        }
        self.load_setup_devices(cx);
        self.hello_go(Card::Welcome, window, cx);
        self.hello_check_gh(cx);
    }

    fn hello_go(&mut self, card: Card, window: &mut Window, cx: &mut Context<Self>) {
        self.hello.at = Some(card);
        if card == Card::Phone {
            self.hello_pair(cx);
        } else {
            self.hello.poll = None;
        }
        // Return and Esc are the cards' while they're up.
        let focus = self.hello.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        window.focus(&focus, cx);
        crate::web_panels::keyboard_to_app(window);
        cx.notify();
    }

    pub(crate) fn hello_next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(at) = self.hello.at else { return };
        let cards = self.hello_cards();
        let next = cards.iter().position(|c| *c == at).and_then(|i| cards.get(i + 1)).copied();
        match next {
            Some(card) => self.hello_go(card, window, cx),
            // Done on the last card: a new thread, ready to type in.
            None => self.hello_finish(true, window, cx),
        }
    }

    pub(crate) fn hello_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(at) = self.hello.at else { return };
        let cards = self.hello_cards();
        if let Some(card) = cards.iter().position(|c| *c == at).filter(|i| *i > 0).and_then(|i| cards.get(i - 1)).copied() {
            self.hello_go(card, window, cx);
        }
    }

    /// Done, or put away with Esc: they don't come by themselves again, and
    /// Finish setting up shows what's left. Done on the last card opens a
    /// new thread with its box ready to type in: no message written for
    /// them (Mike, 18 Nov, of a last card that sent a patch request from a
    /// temp folder: "This one is a bit weird").
    pub(crate) fn hello_finish(&mut self, new_thread: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.hello.at.take().is_none() {
            return;
        }
        self.hello.poll = None;
        self.hello.qr = None;
        self.hello.signing = None;
        self.hello.sign_watch = None;
        self.hello_drop_unfinished_login();
        self.settings.saved.tour_seen = Some(true);
        self.save_settings_soon(cx);
        if new_thread {
            self.new_thread(cx);
            let composer = self.ensure_new_composer(window, cx);
            composer.update(cx, |c, cx| c.focus(window, cx));
            crate::web_panels::keyboard_to_app(window);
        }
        if std::mem::take(&mut self.hello.open_connectors) && !self.activity_panel_showing(crate::shell::CONNECTORS, cx) {
            self.toggle_under_threads(crate::shell::CONNECTORS, cx);
        }
        if self.setup_checklist().left() > 0 {
            self.show_setup(cx);
        }
        cx.notify();
    }

    // Your agents.

    /// Sign in… on a login that isn't: Terminal on its own sign-in, and the
    /// row spins till the runner sees it signed in.
    fn hello_sign_in(&mut self, id: String, cx: &mut Context<Self>) {
        if let Some(a) = self.logins.account(&id).filter(|a| a.provider_id() == "claude") {
            // A Claude login gets its year-long token in the same go.
            let account = SignInAccount { id: a.id.clone(), provider: "claude".into(), title: a.title.clone(), config_dir: a.config_dir.clone() };
            self.sign_in_for_a_year(account, cx);
        } else if self.logins.account(&id).is_some() {
            self.sign_in_login(&id, cx);
        } else {
            // Nobody's signed in to Claude Code on this Mac yet: its own
            // ~/.claude, which the runner finds once it's there.
            self.sign_in_for_a_year(SignInAccount { id: id.clone(), provider: "claude".into(), title: "Claude Code".into(), config_dir: String::new() }, cx);
        }
        self.hello.signing = Some(id.clone());
        self.hello_watch_sign_in(id, cx);
        cx.notify();
    }

    /// While a login's sign-in is open in Terminal, the runner is asked to
    /// look at it again every 3 s, so the row stops waiting a moment after
    /// it's done rather than at the runner's next sweep, up to ten minutes
    /// later (Mike on Tinker Desk, 18 Nov: "it didn't change after I
    /// connected Claude"). Stops when the row does, or after 15 minutes.
    fn hello_watch_sign_in(&mut self, id: String, cx: &mut Context<Self>) {
        let client = self.client.clone();
        self.hello.sign_watch = Some(cx.spawn(async move |this, cx| {
            for _ in 0..300 {
                cx.background_executor().timer(Duration::from_secs(3)).await;
                let waiting = this.update(cx, |this, _| this.hello.signing.as_deref() == Some(id.as_str()) || this.hello.adding.as_ref().is_some_and(|a| a.id == id)).unwrap_or(false);
                if !waiting {
                    return;
                }
                let res = crate::call(client.clone(), "accounts.recheck", json!({ "accountId": id })).await;
                let go_on = this
                    .update(cx, |this, cx| match res {
                        Ok(v) => {
                            if v["accounts"].is_array() {
                                this.logins.set_accounts(&v["accounts"]);
                                cx.notify();
                            }
                            true
                        }
                        // An older runner: accounts.updated still brings it, later.
                        Err(e) => e.code != -32601,
                    })
                    .unwrap_or(false);
                if !go_on {
                    return;
                }
            }
        }));
    }

    /// Another Claude login: a claude-N folder in the runner's `accounts`
    /// (how the guide says to add one), and Terminal on its sign-in.
    fn hello_add_login(&mut self, cx: &mut Context<Self>) {
        if self.hello.adding.is_some() {
            return;
        }
        let id = rules::next_login_id(&self.logins.accounts);
        let dir = threadbear_client::config::RunnerConfig::from_env().home.join("accounts").join(&id);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            self.error_message = Some(format!("Couldn't make a folder for another login: {e}"));
            cx.notify();
            return;
        }
        self.sign_in_for_a_year(SignInAccount { id: id.clone(), provider: "claude".into(), title: "another Claude login".into(), config_dir: dir.to_string_lossy().into_owned() }, cx);
        self.hello.adding = Some(Adding { id: id.clone(), dir });
        self.hello_watch_sign_in(id, cx);
        cx.notify();
    }

    /// A login that's signed in now (it has an address): no more spinning.
    fn hello_signed_in(&self, id: &str) -> bool {
        self.logins.account(id).is_some_and(|a| a.email.as_deref().is_some_and(|e| !e.is_empty()) && !a.signed_out)
    }

    /// The folder for another login that was never signed in to goes again,
    /// so it doesn't sit in the pools as a login that can't run anything.
    /// Only the one this app made, and only while it's still without one.
    fn hello_drop_unfinished_login(&mut self) {
        let Some(adding) = self.hello.adding.take() else { return };
        if self.hello_signed_in(&adding.id) || adding.dir.join(".claude.json").exists() {
            return;
        }
        if adding.dir.file_name().is_some_and(|n| n.to_string_lossy().starts_with("claude-")) {
            let _ = std::fs::remove_dir_all(&adding.dir);
        }
    }

    // Where threads start.

    fn hello_choose_folder(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Choose".into()) });
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = paths.await {
                if let Some(path) = paths.pop() {
                    this.update(cx, |this, cx| this.update_runner_settings(json!({ "defaultCwd": path.to_string_lossy() }), cx)).ok();
                }
            }
        })
        .detach();
    }

    /// Who GitHub's CLI is signed in as, read once. Agents use it for pull
    /// requests, so it's worth knowing it's there; nothing more is done
    /// with it.
    fn hello_check_gh(&mut self, cx: &mut Context<Self>) {
        if self.hello.gh.is_some() {
            return;
        }
        let task = cx.background_executor().spawn(async move {
            // An app opened from the Dock has launchd's short PATH, so the
            // places Homebrew puts it are tried first.
            for gh in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"] {
                if let Ok(out) = std::process::Command::new(gh).args(["auth", "status", "--hostname", "github.com"]).output() {
                    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
                    return rules::gh_account(&text).unwrap_or_default();
                }
            }
            String::new()
        });
        cx.spawn(async move |this, cx| {
            let account = task.await;
            this.update(cx, |this, cx| {
                this.hello.gh = Some(account);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // Phone.

    /// A code for a phone, unless one's paired already, and a look at the
    /// paired devices every two seconds while the card's up.
    fn hello_pair(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let want_code = self.hello.qr.is_none() && !self.hello.pairing;
        if want_code {
            self.hello.pairing = true;
            self.hello.pair_error = None;
        }
        self.hello.poll = Some(cx.spawn(async move |this, cx| {
            let list = crate::call(client.clone(), "devices.list", json!({})).await;
            let already = this
                .update(cx, |this, cx| {
                    if let Ok(v) = &list {
                        this.hello.devices = DeviceList::decode(v);
                    }
                    if this.hello.phones_before.is_none() {
                        this.hello.phones_before = Some(this.hello.devices.devices.iter().filter(|d| d.kind == Kind::Phone).map(|d| d.id.clone()).collect());
                    }
                    cx.notify();
                    rules::paired_phone(&this.hello.devices.devices).is_some()
                })
                .unwrap_or(false);
            if want_code && !already {
                let res = crate::call(client.clone(), "devices.pair", json!({ "kind": "phone", "name": "iPhone" })).await;
                this.update(cx, |this, cx| {
                    match res {
                        // The link goes into the code and no further.
                        Ok(v) => this.hello.qr = v["pairingLink"].as_str().and_then(threadbear_core::devices::pairing_qr),
                        // Only that it failed: the answer would have held the token.
                        Err(e) => this.hello.pair_error = Some(e.message),
                    }
                    cx.notify();
                })
                .ok();
            }
            this.update(cx, |this, cx| {
                this.hello.pairing = false;
                cx.notify();
            })
            .ok();
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let list = crate::call(client.clone(), "devices.list", json!({})).await;
                let paired = this
                    .update(cx, |this, cx| {
                        if let Ok(v) = &list {
                            this.hello.devices = DeviceList::decode(v);
                            this.setup.devices = this.hello.devices.clone();
                        }
                        cx.notify();
                        this.hello_new_phone().is_some()
                    })
                    .unwrap_or(true);
                if paired {
                    break;
                }
            }
        }));
        cx.notify();
    }

    fn hello_new_phone(&self) -> Option<String> {
        let before = self.hello.phones_before.as_deref().unwrap_or(&[]);
        rules::newly_paired(&self.hello.devices.devices, before).map(|d| d.name.clone())
    }

    // Drawing.

    pub(crate) fn render_hello(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        let at = self.hello.at?;
        let cards = self.hello_cards();
        let index = cards.iter().position(|c| *c == at).unwrap_or(0);
        let viewport = window.viewport_size();
        let bg = cx.theme().background;
        let dot = style::label_text(cx).opacity(0.06);
        let card = self.render_hello_card(at, index, window, cx);
        let pager = h_flex().gap(px(7.)).children((0..cards.len()).map(|i| div().size(px(6.)).rounded_full().bg(style::label_text(cx).opacity(if i == index { 0.8 } else { 0.22 }))));
        let focus = self.hello.focus.get_or_insert_with(|| cx.focus_handle()).clone();
        let layer = div()
            .id("hello")
            .absolute()
            .top_0()
            .left_0()
            .w(viewport.width)
            .h(viewport.height)
            .bg(bg)
            .occlude()
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            // A faint grid of dots behind the card.
            .child(
                canvas(
                    |_, _, _| {},
                    move |b, _, window, _| {
                        let step = 14.;
                        let (w, h) = (b.size.width.as_f32(), b.size.height.as_f32());
                        let mut y = step / 2.;
                        while y < h {
                            let mut x = step / 2.;
                            while x < w {
                                window.paint_quad(fill(Bounds::new(point(b.origin.x + gpui_kit::px(x), b.origin.y + gpui_kit::px(y)), size(gpui_kit::px(1.4), gpui_kit::px(1.4))), dot));
                                x += step;
                            }
                            y += step;
                        }
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
            // Centred, with auto margins rather than justify_center, so in a
            // window too short for the card it scrolls rather than its top
            // (and the bear) going off the window.
            .child(div().id("hello-scroll").absolute().top_0().left_0().size_full().overflow_y_scroll().child(v_flex().min_h_full().items_center().py(px(24.)).child(v_flex().my_auto().items_center().gap(px(26.)).child(card).child(pager))))
            .track_focus(&focus)
            .key_context("Hello")
            .on_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| match ev.keystroke.key.as_str() {
                "enter" => {
                    cx.stop_propagation();
                    this.hello_next(window, cx);
                }
                "escape" => {
                    cx.stop_propagation();
                    this.hello_finish(false, window, cx);
                }
                _ => {}
            }));
        Some(deferred(layer).with_priority(4).into_any_element())
    }

    fn render_hello_card(&mut self, at: Card, index: usize, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let fg = style::label_text(cx);
        let secondary = style::secondary_text(cx);
        let signed_in = rules::any_ready(&self.logins.accounts);
        let body: AnyElement = match at {
            Card::Welcome => div().into_any_element(),
            Card::Agents => self.render_hello_agents(cx),
            Card::Folder => self.render_hello_folder(cx),
            Card::Phone => self.render_hello_phone(cx),
            Card::Extras => self.render_hello_extras(window, cx),
        };
        // Back, Skip and the card's own button, Return on the last.
        let mut foot = h_flex().items_center().gap(px(14.)).pt(px(6.)).text_size(px(style::size::LABEL));
        if index > 0 {
            foot = foot.child(link("hello-back", "← Back", "The card before", secondary).on_click(cx.listener(|this, _, window, cx| this.hello_back(window, cx))));
        }
        foot = foot.child(div().flex_1());
        if at != Card::Welcome {
            foot = foot.child(link("hello-skip", "Skip", "Leave this for now; Finish setting up keeps what's left", secondary).on_click(cx.listener(|this, _, window, cx| this.hello_next(window, cx))));
        }
        let primary = if at == Card::Phone && self.hello_new_phone().is_none() && rules::paired_phone(&self.hello.devices.devices).is_none() { "Later" } else { at.primary() };
        let tip = if at == Card::Extras { "Done: start a new thread (Return)" } else { "On to the next card (Return)" };
        foot = foot.child(crate::tour::prominent_button("hello-next", primary, tip, true, cx).child(div().ml(px(8.)).px(px(4.)).rounded(px(3.)).border(gpui_kit::px(1.)).border_color(gpui_kit::white().opacity(0.45)).text_size(px(10.)).child("↵")).on_click(cx.listener(|this, _, window, cx| this.hello_next(window, cx))));
        let shadow = vec![BoxShadow { color: hsla(0., 0., 0., 0.35), offset: point(gpui_kit::px(0.), gpui_kit::px(18.)), blur_radius: gpui_kit::px(48.), spread_radius: gpui_kit::px(0.), inset: false }];
        let pose = at.pose(signed_in || at != Card::Agents);
        div()
            .relative()
            .pt(px(BEAR_HEIGHT * 0.62))
            .child(
                v_flex()
                    .id("hello-card")
                    .w(px(CARD_WIDTH))
                    .pt(px(BEAR_HEIGHT * 0.45))
                    .px(px(26.))
                    .pb(px(20.))
                    .gap(px(14.))
                    .rounded(gpui_kit::px(14.))
                    .bg(style::card_background(cx))
                    .border(gpui_kit::px(0.5))
                    .border_color(style::hairline(cx))
                    .shadow(shadow)
                    .child(v_flex().gap(px(4.)).child(div().text_size(px(20.)).font_semibold().text_color(fg).child(at.title())).child(div().text_size(px(style::size::LABEL)).text_color(secondary).child(at.body(signed_in))))
                    .child(body)
                    .child(foot),
            )
            // The bear sits on the card's top edge, a different one per card.
            .child(div().absolute().top_0().left(px(22.)).h(px(BEAR_HEIGHT)).child(img(ImageSource::Image(bear(pose))).h(px(BEAR_HEIGHT)).object_fit(ObjectFit::Contain)))
            .into_any_element()
    }

    fn render_hello_agents(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let all = rules::agent_rows(&self.logins.accounts);
        let rows = rules::shown_rows(all.clone());
        // Done spinning once the login's signed in.
        if self.hello.signing.as_deref().is_some_and(|id| self.hello_signed_in(id) || (id == "claude-main" && rules::any_ready(&self.logins.accounts))) {
            self.hello.signing = None;
        }
        if self.hello.adding.as_ref().is_some_and(|a| self.hello_signed_in(&a.id)) {
            self.hello.adding = None;
        }
        let adding = self.hello.adding.as_ref().map(|a| a.id.clone());
        let mut list: Vec<AnyElement> = vec![];
        for row in rows.iter().filter(|r| Some(&r.id) != adding.as_ref()) {
            let right: Option<AnyElement> = match row.state {
                AgentState::Ready => None,
                AgentState::PlanEnded => None,
                AgentState::SignedOut => {
                    let id = row.id.clone();
                    let busy = self.hello.signing.as_deref() == Some(row.id.as_str());
                    Some(PushButton::new(SharedString::from(format!("hello-sign-in-{}", row.id)), if busy { "Waiting" } else { "Sign in…" }, if busy { "Finish signing in in Terminal and your browser" } else if row.id.starts_with("claude") { "Opens Terminal to sign in, then makes it last a year" } else { "Opens Terminal on this login's own sign-in" }).busy(busy).render(cx, {
                        let app = cx.entity().downgrade();
                        move |_, _, cx| {
                            app.update(cx, |this, cx| this.hello_sign_in(id.clone(), cx)).ok();
                        }
                    }))
                }
            };
            let tag = (row.state == AgentState::Ready).then_some("Signed in");
            list.push(hello_row(&row.provider, row.name.clone(), tag, row.detail.clone(), right, cx));
        }
        if all.iter().all(|r| r.provider != "claude") {
            // Nothing signed in to Claude Code here yet: its own sign-in.
            let busy = self.hello.signing.as_deref() == Some("claude-main");
            let button = PushButton::new("hello-sign-in-claude", if busy { "Waiting" } else { "Sign in…" }, if busy { "Finish signing in in Terminal and your browser" } else { "Opens Terminal to sign in to Claude Code, then makes it last a year" }).busy(busy).render(cx, {
                let app = cx.entity().downgrade();
                move |_, _, cx| {
                    app.update(cx, |this, cx| this.hello_sign_in("claude-main".into(), cx)).ok();
                }
            });
            list.push(hello_row("claude", "Claude Code".into(), None, "Not signed in on this Mac".into(), Some(button), cx));
        }
        // Another Claude login, for a second subscription: the pool moves a
        // thread to it when the first runs low.
        if all.iter().any(|r| r.provider == "claude" && r.state == AgentState::Ready) || adding.is_some() {
            let busy = adding.is_some();
            let button = PushButton::new("hello-add-login", if busy { "Waiting" } else { "Add" }, if busy { "Finish signing in in Terminal and your browser" } else { "Sign in to another Claude account in Terminal, for a year" }).busy(busy).render(cx, {
                let app = cx.entity().downgrade();
                move |_, _, cx| {
                    app.update(cx, |this, cx| this.hello_add_login(cx)).ok();
                }
            });
            let detail = if busy { "Finish in Terminal and your browser".to_owned() } else { "A thread moves to it when one runs low".to_owned() };
            list.push(hello_row("plus", "Another Claude login".into(), None, detail, Some(button), cx));
        }
        let mut col = v_flex().gap(px(8.)).child(group(list, cx));
        if let Some(line) = rules::pool_line(&self.logins.pools, &self.logins.accounts) {
            col = col.child(div().text_size(px(style::size::DETAIL)).text_color(style::secondary_text(cx)).child(line));
        }
        col.into_any_element()
    }

    fn render_hello_folder(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let folder = self.runner_settings.as_ref().and_then(|s| s["defaultCwd"].as_str()).unwrap_or("").to_owned();
        let shown = abbreviate_home(&folder);
        let change = PushButton::new("hello-folder", "Change…", "Pick the folder new threads start in").render(cx, {
            let app = cx.entity().downgrade();
            move |_, window, cx| {
                app.update(cx, |this, cx| this.hello_choose_folder(window, cx)).ok();
            }
        });
        let mut rows = vec![hello_row("folder", if shown.is_empty() { "Your threads folder".into() } else { shown }, None, "Or pick another as you start a thread".into(), Some(change), cx)];
        let gh: (Option<&'static str>, String) = match self.hello.gh.as_deref() {
            None => (None, "Looking…".into()),
            Some("") => (None, "Not signed in; agents still commit on this Mac".into()),
            Some(who) => (Some("Signed in"), format!("As {who}, for pull requests")),
        };
        rows.push(hello_row("link", "GitHub".into(), gh.0, gh.1, None, cx));
        group(rows, cx)
    }

    fn render_hello_phone(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let fg = style::label_text(cx);
        let secondary = style::secondary_text(cx);
        let accent = style::accent(cx);
        let paired = self.hello_new_phone().map(|name| (name, "Paired just now")).or_else(|| rules::paired_phone(&self.hello.devices.devices).map(|d| (d.name.clone(), "Paired already")));
        if let Some((name, when)) = paired {
            return group(vec![hello_row("iphone", name, Some("Paired"), when.into(), None, cx)], cx);
        }
        let code: AnyElement = match (&self.hello.qr, &self.hello.pair_error) {
            (Some(qr), _) => div().size(px(136.)).p(px(6.)).rounded(px(8.)).bg(gpui_kit::white()).child(crate::settings_window::devices::qr_canvas(qr.clone())).into_any_element(),
            (None, Some(_)) => div().size(px(136.)).flex().items_center().justify_center().text_color(secondary).text_size(px(style::size::DETAIL)).child("No code").into_any_element(),
            (None, None) => div().size(px(136.)).flex().items_center().justify_center().child(crate::spinner::Spinner::new()).into_any_element(),
        };
        let status: AnyElement = match &self.hello.pair_error {
            Some(e) => div().text_color(secondary).child(format!("Couldn't make a code: {e}")).into_any_element(),
            None => h_flex().gap(px(6.)).items_center().text_color(secondary).child(crate::spinner::Spinner::new()).child("Waiting for your phone").into_any_element(),
        };
        let website_busy = self.setup.opening;
        h_flex()
            .gap(px(20.))
            .items_center()
            .child(code)
            .child(
                v_flex()
                    .gap(px(10.))
                    .text_size(px(style::size::LABEL))
                    .child(h_flex().gap(px(4.)).text_color(fg).child("Scan it with").child(div().font_semibold().child("Threadbear for iPhone")))
                    .child(status)
                    .child(h_flex().gap(px(4.)).text_color(secondary).child("No app yet?").child(link("hello-app-store", "Get it on the App Store", "The iPhone app's page", accent).on_click(|_, _, cx| {
                        crate::open_gate::open_web(rules::APP_STORE, cx);
                    })))
                    .child(h_flex().gap(px(4.)).text_color(secondary).child("Or").child(link("hello-website", if website_busy { "opening…" } else { "open your threads in a browser" }, "Opens your Threadbear website, signed in", accent).on_click(cx.listener(|this, _, _, cx| this.setup_open_website_now(cx))))),
            )
            .into_any_element()
    }

    fn render_hello_extras(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let settings = self.runner_settings.clone().unwrap_or(Value::Null);
        let mut rows = vec![];
        if let Some(on) = settings["labReview"].as_bool() {
            let switch = switch("hello-lab-review", on, "Have another lab check each code change a thread makes", cx, |this, on, cx| this.update_runner_settings(json!({ "labReview": on }), cx));
            rows.push(hello_row("checkmark", "Review by another lab".into(), Some("Recommended"), "Codex checks Claude's code changes, and the other way round".into(), Some(switch), cx));
        }
        if let Some(on) = settings["keepAwake"].as_bool() {
            let switch = switch("hello-keep-awake", on, "Stop your Mac sleeping on its own while a thread is working", cx, |this, on, cx| this.update_runner_settings(json!({ "keepAwake": on }), cx));
            rows.push(hello_row("moon", "Keep the Mac awake".into(), None, "So a long thread isn't cut off halfway".into(), Some(switch), cx));
        }
        let connectors = self.hello.open_connectors;
        let button = PushButton::new("hello-connectors", if connectors { "Opens next" } else { "Show me" }, "Opens Connectors once you're done here").render(cx, {
            let app = cx.entity().downgrade();
            move |_, _, cx| {
                app.update(cx, |this, cx| {
                    this.hello.open_connectors = !this.hello.open_connectors;
                    cx.notify();
                })
                .ok();
            }
        });
        rows.push(hello_row("powerplug", "Connectors".into(), None, "Notion, Gmail, Sentry and more".into(), Some(button), cx));
        let now = style::appearance();
        let looks = h_flex().gap(px(4.)).children(style::Appearance::ALL.into_iter().map(|choice| {
            let on = choice == now;
            div()
                .id(SharedString::from(format!("hello-look-{}", choice.name())))
                .role(Role::Tab)
                .aria_selected(on)
                .px(px(8.))
                .py(px(3.))
                .rounded(px(5.))
                .cursor_pointer()
                .text_size(px(style::size::DETAIL))
                .when(on, |d| d.bg(style::label_text(cx).opacity(0.12)))
                .text_color(if on { style::label_text(cx) } else { style::secondary_text(cx) })
                .child(choice.title())
                .tip(format!("Use the {} look", choice.title().to_lowercase()))
                .on_click(cx.listener(move |this, _, window, cx| this.set_appearance(choice, window, cx)))
        }));
        let _ = window;
        rows.push(hello_row("sun.max", "Look".into(), None, String::new(), Some(looks.into_any_element()), cx));
        group(rows, cx)
    }

    /// The automation's `hello`: {"do": "start"|"next"|"back"|"skip"|"end"};
    /// says the card: "ok 2/6 agents".
    #[cfg(feature = "automation")]
    pub(crate) fn hello_command(&mut self, cmd: &Value, window: &mut Window, cx: &mut Context<Self>) -> Result<String, String> {
        match cmd["do"].as_str() {
            Some("start") => self.hello_start(window, cx),
            Some("next") => self.hello_next(window, cx),
            Some("back") => self.hello_back(window, cx),
            Some("skip") => self.hello_next(window, cx),
            Some("end") => self.hello_finish(false, window, cx),
            None => {}
            Some(_) => return Err("do is start, next, back, skip or end".into()),
        }
        Ok(self.hello_line())
    }

    #[cfg(feature = "automation")]
    fn hello_line(&self) -> String {
        let Some(at) = self.hello.at else { return "ok off".into() };
        let cards = self.hello_cards();
        let i = cards.iter().position(|c| *c == at).unwrap_or(0);
        format!("ok {}/{} {}", i + 1, cards.len(), at.name())
    }

    /// The cards in `dump`.
    pub(crate) fn hello_dump(&self) -> Value {
        let Some(at) = self.hello.at else { return Value::Null };
        let cards = self.hello_cards();
        json!({
            "card": at.name(),
            "title": at.title(),
            "index": cards.iter().position(|c| *c == at).map(|i| i + 1),
            "count": cards.len(),
            "cards": cards.iter().map(|c| c.name()).collect::<Vec<_>>(),
            "agents": rules::agent_rows(&self.logins.accounts).iter().map(|r| json!({ "id": r.id, "name": r.name, "detail": r.detail, "ready": r.state == AgentState::Ready })).collect::<Vec<_>>(),
            "signing": self.hello.signing,
            "adding": self.hello.adding.as_ref().map(|a| a.id.clone()),
            "gh": self.hello.gh,
            "code": self.hello.qr.is_some(),
            "paired": self.hello_new_phone(),
        })
    }
}

/// A row: the thing's mark, its name with a green tag when it's there, a
/// line under it, and its control on the right.
fn hello_row(icon: &str, title: String, tag: Option<&str>, detail: String, right: Option<AnyElement>, cx: &App) -> AnyElement {
    let fg = style::label_text(cx);
    let secondary = style::secondary_text(cx);
    let green = hsla(145. / 360., 0.45, 0.55, 1.);
    let mark = if matches!(icon, "claude" | "codex") { crate::icons::provider_mark(icon) } else { crate::icons::symbol(icon) };
    // Long words (the first message) wrap rather than being cut off.
    let mut name = h_flex().gap(px(8.)).items_center().child(div().min_w_0().text_size(px(style::size::LABEL)).font_medium().text_color(fg).child(title));
    match tag {
        // The app's one mark for what it would pick: the gold star.
        Some("Recommended") => {
            let star = style::recommended_star(cx);
            name = name.child(h_flex().flex_none().gap(px(3.)).items_center().text_size(px(style::size::DETAIL)).text_color(star).child("★").child("Recommended"));
        }
        Some(tag) => {
            name = name.child(h_flex().flex_none().gap(px(4.)).items_center().text_size(px(style::size::DETAIL)).text_color(green).child(div().size(px(6.)).rounded_full().bg(green)).child(tag.to_owned()));
        }
        None => {}
    }
    h_flex()
        .gap(px(12.))
        .items_center()
        .px(px(14.))
        .py(px(10.))
        .child(div().flex_none().size(px(28.)).rounded(px(7.)).bg(fg.opacity(0.07)).flex().items_center().justify_center().child(mark.with_size(px(14.)).text_color(fg.opacity(0.8))))
        .child(v_flex().flex_1().min_w_0().gap(px(2.)).child(name).when(!detail.is_empty(), |c| c.child(div().text_size(px(style::size::DETAIL)).text_color(secondary).child(detail))))
        .children(right.map(|r| div().flex_none().child(r)))
        .into_any_element()
}

/// Rows in one rounded box, a hairline between each.
fn group(rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    let line = style::hairline(cx);
    let n = rows.len();
    v_flex()
        .rounded(px(10.))
        .border(gpui_kit::px(0.5))
        .border_color(line)
        .overflow_hidden()
        .children(rows.into_iter().enumerate().map(|(i, r)| div().when(i + 1 < n, |d| d.border_b(gpui_kit::px(0.5)).border_color(line)).child(r)))
        .into_any_element()
}

fn link(id: &'static str, label: &'static str, tip: &'static str, color: Hsla) -> Stateful<Div> {
    div().id(id).role(Role::Button).cursor_pointer().text_color(color).child(label).tip(tip)
}

fn switch(id: &'static str, on: bool, tip: &'static str, cx: &mut Context<Threadbear>, set: impl Fn(&mut Threadbear, bool, &mut Context<Threadbear>) + 'static) -> AnyElement {
    let app = cx.entity().downgrade();
    div()
        .id(SharedString::from(format!("{id}-holder")))
        // Found by its tip, as Settings' switches are (the automation's `click`).
        .test_support()
        .a11y_role(Role::GenericContainer)
        .aria_label(tip)
        .tip(tip)
        .child(crate::mac_switch::MacSwitch::new(SharedString::from(id), on).outside_form().on_change(move |on, _, cx| {
            app.update(cx, |this, cx| set(this, on, cx)).ok();
        }))
        .into_any_element()
}

fn abbreviate_home(path: &str) -> String {
    threadbear_core::new_thread::abbreviate_home(path, &crate::files::home_dir())
}
