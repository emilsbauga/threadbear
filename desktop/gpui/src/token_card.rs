// The in-thread token card (docs/virtual-runners.md, "What it's like when it's
// done"; docs/protocol.md, "Cloud tokens on the Mac"). A thread on a virtual
// runner whose Claude login has no cloud token, or only one Claude refused,
// shows one card on its composer, as the limit box does: Make one (claude
// setup-token on this Mac, approved on claude.ai in the browser), Paste a
// token, or, when this Mac's login of that email runs on a year-long token,
// Use this Mac's token. Mike picked this on 17 Nov ("option C, just in time,
// in the thread") over a switch per login in Settings or setup cards.
//
// Each click shows at once: a spinner in the card with every button off until
// the runner answers. Once it has, the card goes at once for that login and
// comes back only if its box still says so half a minute later.
//
// A pasted token goes from its masked field straight into the one request and
// out of the field the moment it goes: it's never logged, saved as a draft or
// kept anywhere in the app.
use crate::app::Threadbear;
use crate::composer::Composer;
use crate::style::{self, px};
use crate::tips::Tip as _;
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::input::{InputEvent, InputState};
use crate::a11y::A11yRole as _;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::*;
use serde_json::json;
use std::collections::HashMap;
use threadbear_core::remote::TokenCard;

/// How long the card stays away after a token was set, waiting for the box to
/// say it has one, before it shows again.
const HIDE_MS: i64 = 30_000;

/// What's under way for one login's card.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Busy {
    /// `claude setup-token` is running, waiting on claude.ai.
    Make,
    /// A pasted token, or this Mac's, on its way to the backend.
    Set,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CardState {
    pub(crate) busy: Option<Busy>,
    pub(crate) error: Option<String>,
    /// The paste field is open.
    pub(crate) pasting: bool,
    /// A token was set: hidden until then, unless the box stops asking first.
    pub(crate) hidden_until_ms: Option<i64>,
}

/// Every login's card, on the app: two threads of one login share it.
#[derive(Default)]
pub(crate) struct TokenCards {
    pub(crate) by_login: HashMap<String, CardState>,
}

/// Which way the token comes.
pub(crate) enum How {
    Make,
    Paste(String),
    Mac,
}

impl Threadbear {
    /// The thread's card, and how it's going, while its box waits on a token.
    pub(crate) fn token_card_for(&self, thread_id: &str) -> Option<(TokenCard, CardState)> {
        let thread = self.threads.get(thread_id)?;
        if thread.is_archived() || thread.moving.is_some() {
            return None;
        }
        let card = threadbear_core::remote::token_card(self.remote.box_of(thread.runner_id.as_deref())?, &self.logins)?;
        let state = self.token_cards.by_login.get(&card.login).cloned().unwrap_or_default();
        if state.hidden_until_ms.is_some_and(|until| crate::now_ms() < until) && state.busy.is_none() {
            return None;
        }
        Some((card, state))
    }

    pub(crate) fn toggle_token_paste(&mut self, login: &str, cx: &mut Context<Self>) {
        let state = self.token_cards.by_login.entry(login.to_owned()).or_default();
        if state.busy.is_none() {
            state.pasting = !state.pasting;
            state.error = None;
        }
        cx.notify();
    }

    /// Make one, a pasted one, or this Mac's: the card spins with its buttons
    /// off until the runner answers (cloudTokens.make can take minutes, as
    /// it waits on Mike in the browser).
    pub(crate) fn set_cloud_token(&mut self, login: String, how: How, cx: &mut Context<Self>) {
        let state = self.token_cards.by_login.entry(login.clone()).or_default();
        if state.busy.is_some() {
            return;
        }
        let (method, params) = match how {
            How::Make => ("cloudTokens.make", json!({ "login": login })),
            How::Paste(token) => ("cloudTokens.set", json!({ "login": login, "token": token.trim() })),
            How::Mac => ("cloudTokens.useMac", json!({ "login": login })),
        };
        state.busy = Some(if method == "cloudTokens.make" { Busy::Make } else { Busy::Set });
        state.error = None;
        cx.notify();
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let res = crate::call(client, method, params).await;
            this.update(cx, |t, cx| {
                let state = t.token_cards.by_login.entry(login.clone()).or_default();
                state.busy = None;
                match res {
                    Ok(_) => {
                        state.pasting = false;
                        state.hidden_until_ms = Some(crate::now_ms() + HIDE_MS);
                        let refresh = cx.spawn(async move |this, cx| {
                            cx.background_executor().timer(std::time::Duration::from_millis(HIDE_MS as u64 + 100)).await;
                            this.update(cx, |_, cx| cx.notify()).ok();
                        });
                        refresh.detach();
                    }
                    Err(e) if e.code == -32601 => state.error = Some("This Mac's runner is too old to set a cloud token. It updates by itself.".to_owned()),
                    Err(e) => state.error = Some(e.message),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(feature = "automation")]
impl Threadbear {
    /// The open thread's card as `dump` says it: its words, its buttons, and
    /// what's under way.
    pub(crate) fn token_card_dump(&self) -> serde_json::Value {
        let Some((card, state)) = self.open_thread().and_then(|t| self.token_card_for(&t.id)) else { return serde_json::Value::Null };
        let mut buttons = vec!["Make one", "Paste a token"];
        if card.mac_account.is_some() {
            buttons.push("Use this Mac's token");
        }
        json!({
            "text": card.text,
            "login": card.login,
            "buttons": buttons,
            "busy": state.busy.map(|b| if b == Busy::Make { "Waiting for claude.ai" } else { "Setting it" }),
            "pasting": state.pasting,
            "error": state.error,
        })
    }

    /// `{"cmd":"token-card","press":"Make one"}` presses one of the card's
    /// buttons as a click does (a pasted token is never typed by a script).
    pub(crate) fn token_card_press(&mut self, press: &str, cx: &mut Context<Self>) -> Result<(), String> {
        let (card, state) = self.open_thread().and_then(|t| self.token_card_for(&t.id)).ok_or("no token card on the open thread")?;
        if state.busy.is_some() {
            return Err("the card is busy".to_owned());
        }
        match press {
            "Make one" => self.set_cloud_token(card.login, How::Make, cx),
            "Paste a token" => self.toggle_token_paste(&card.login, cx),
            "Use this Mac's token" if card.mac_account.is_some() => self.set_cloud_token(card.login, How::Mac, cx),
            other => return Err(format!("the card has no {other:?}")),
        }
        Ok(())
    }
}

impl Composer {
    /// The card, at the top of the box over a line, as the limit box is.
    pub(crate) fn render_token_card(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        use gpui_kit::component::button::{Button, ButtonVariants as _};
        use gpui_kit::component::Disableable as _;
        let thread_id = self.thread_id.clone()?;
        let app = self.app.upgrade()?;
        let (card, state) = app.read(cx).token_card_for(&thread_id)?;
        let busy = state.busy.is_some();
        let secondary = style::secondary_text(cx);
        let mark = crate::icons::symbol("key").with_size(px(13.)).text_color(if card.dead { cx.theme().danger } else { style::needs_you(cx) });
        let heading = h_flex()
            .items_start()
            .gap(px(8.))
            .child(div().flex_none().pt(px(1.)).child(mark))
            .child(div().id("token-card-text").flex_1().min_w_0().tip(card.tip.clone()).child(card.text.clone()));
        let mut column = v_flex().w_full().gap(px(8.)).px(px(style::COMPOSER_PADDING)).pt(px(10.)).pb(px(10.)).text_size(px(style::size::LABEL)).line_height(px(16.)).child(heading);
        let login = card.login.clone();
        let mut row = h_flex().flex_wrap().gap(px(10.)).items_center();
        // Make one leads: the default, a token of the box's own.
        let (app_m, who) = (self.app.clone(), login.clone());
        let make_tip = format!("Runs claude setup-token for {login} on this Mac. Approve it on claude.ai in your browser; there's nothing to copy");
        row = row.child(
            div().id("token-make").test_support().a11y_role(Role::GenericContainer).aria_label(make_tip.clone()).child(
                Button::new("token-make-button").label("Make one").small().primary().loading(state.busy == Some(Busy::Make)).disabled(busy).tooltip(make_tip).on_click(move |_, _, cx| {
                    app_m.update(cx, |a, cx| a.set_cloud_token(who.clone(), How::Make, cx)).ok();
                }),
            ),
        );
        let (app_p, who) = (self.app.clone(), login.clone());
        let paste_tip = "Paste a token you made with claude setup-token";
        row = row.child(
            div().id("token-paste").test_support().a11y_role(Role::GenericContainer).aria_label(paste_tip).child(
                Button::new("token-paste-button").label("Paste a token").small().secondary().disabled(busy).tooltip(paste_tip).on_click(move |_, _, cx| {
                    app_p.update(cx, |a, cx| a.toggle_token_paste(&who, cx)).ok();
                }),
            ),
        );
        if card.mac_account.is_some() {
            let (app_u, who) = (self.app.clone(), login.clone());
            let mac_tip = format!("Use the year-long token {login} already runs on here. A separate one is safer: revoking a shared one signs this Mac out too");
            row = row.child(
                div().id("token-mac").test_support().a11y_role(Role::GenericContainer).aria_label(mac_tip.clone()).child(
                    Button::new("token-mac-button").label("Use this Mac's token").small().secondary().disabled(busy).tooltip(mac_tip).on_click(move |_, _, cx| {
                        app_u.update(cx, |a, cx| a.set_cloud_token(who.clone(), How::Mac, cx)).ok();
                    }),
                ),
            );
        }
        // How it's going, after the buttons: waiting on the browser, or the
        // runner setting it.
        if let Some(b) = state.busy {
            let (words, tip) = match b {
                Busy::Make => ("Waiting for claude.ai", "Approve it in the browser window claude setup-token opened. It gives up after 10 minutes."),
                Busy::Set => ("Setting it", "Sealing it in your backend"),
            };
            row = row.child(
                h_flex()
                    .id("token-busy")
                    .gap(px(6.))
                    .items_center()
                    .text_color(secondary)
                    .tip(tip)
                    .child(crate::spinner::Spinner::new().color(style::quiet_text(cx)).with_size(px(12.)))
                    .child(words),
            );
        }
        column = column.child(row);
        if state.pasting {
            column = column.child(self.render_token_paste(&login, busy, window, cx));
        } else {
            self.token_field = None;
        }
        if let Some(error) = state.error.clone() {
            column = column.child(div().id("token-error").text_color(cx.theme().danger).tip(error.clone()).child(error));
        }
        Some(v_flex().w_full().child(column).child(div().w_full().h(gpui_kit::px(1.)).bg(style::hairline(cx))).into_any_element())
    }

    /// The masked field and Set; Return sets too.
    fn render_token_paste(&mut self, login: &str, busy: bool, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        use gpui_kit::component::button::{Button, ButtonVariants as _};
        use gpui_kit::component::input::Input;
        use gpui_kit::component::Disableable as _;
        let field = match &self.token_field {
            Some((who, field)) if who == login => field.clone(),
            _ => {
                let field = cx.new(|cx| {
                    let mut state = InputState::new(window, cx).placeholder("sk-ant-oat01-…");
                    state.set_masked(true, window, cx);
                    state
                });
                // A pasted token not yet set: an update's restart waits for it
                // (its words are never kept anywhere).
                crate::unsent::watch(&field, "a cloud token's field", cx);
                let who = login.to_owned();
                let sub = cx.subscribe_in(&field, window, move |this, field, event: &InputEvent, window, cx| {
                    if let InputEvent::PressEnter { .. } = event {
                        this.send_pasted_token(&who, field.clone(), window, cx);
                    }
                });
                self.token_sub = Some(sub);
                self.token_field = Some((login.to_owned(), field.clone()));
                window.focus(&field.read(cx).focus_handle(cx), cx);
                crate::web_panels::keyboard_to_app(window);
                field
            }
        };
        let (who, for_set) = (login.to_owned(), field.clone());
        let set = div().id("token-set").test_support().a11y_role(Role::GenericContainer).aria_label("Set this token").child(
            Button::new("token-set-button").label("Set").small().secondary().disabled(busy).tooltip("Set this token for the login").on_click(cx.listener(move |this, _, window, cx| {
                this.send_pasted_token(&who, for_set.clone(), window, cx);
            })),
        );
        h_flex().gap(px(8.)).items_center().child(div().id("token-field").flex_1().min_w_0().tip("A token from claude setup-token, starting sk-ant-oat01-").child(Input::new(&field).small().disabled(busy))).child(set).into_any_element()
    }

    /// The field's token goes into the one request and out of the field.
    fn send_pasted_token(&mut self, login: &str, field: Entity<InputState>, window: &mut Window, cx: &mut Context<Self>) {
        let token = field.read(cx).value().trim().to_owned();
        if token.is_empty() {
            return;
        }
        field.update(cx, |s, cx| s.set_value("", window, cx));
        crate::unsent::saved(&field, cx);
        if let Some(app) = self.app.upgrade() {
            app.update(cx, |a, cx| a.set_cloud_token(login.to_owned(), How::Paste(token), cx));
        }
    }
}
