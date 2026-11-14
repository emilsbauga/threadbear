//! Backlog uses the runner's existing draft records, including existing saved tasks.
use crate::{app::Threadbear, composer::Composer, call};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use threadbear_core::{backlog, inbox::ThreadSummary};
use std::time::Duration;
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use crate::tips::Tip as _;
use crate::style::px;

impl Threadbear {
    pub(crate) fn create_backlog(&mut self, text: String, images: Vec<threadbear_core::reducer::ImageRef>, stored: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_thread.creating || self.new_thread.picks.runner.is_some() { return; }
        if !matches!(self.status, threadbear_client::runner::Status::Connected { .. }) {
            self.new_thread.error = Some("Connect to the runner to save to Backlog.".into());
            cx.notify();
            return;
        }
        let logins = self.draft_logins();
        let mut params = self.with_draft(&logins, |d| d.create_params(&text, images.iter().map(crate::composer::image_ref_json).collect(), false));
        if let Some(project) = &self.new_thread.picks.project { params["projectIds"] = json!([project]); }
        let account = self.with_draft(&logins, |d| d.account_id());
        let used_pool = params.get("poolId").is_some();
        self.new_thread.creating = true;
        self.new_thread.error = None;
        self.folded.remove("backlog");
        let client = self.client.clone();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = call(client, "threads.createDraft", params).await;
            this.update_in(cx, |this, window, cx| this.finish_new_thread(result, stored, None, None, account, used_pool, window, cx)).ok();
        }).detach();
    }

    pub(crate) fn set_backlogged(&mut self, id: &str, later: bool, cx: &mut Context<Self>) {
        let Some(t) = self.threads.get(id) else { return };
        if t.backlog.is_some() || t.is_archived() || (later && (t.busy() || t.working_in_background() || t.snoozed_until.is_some())) { return; }
        self.folded.remove("backlog");
        self.update_thread(id, move |t| t.backlogged = later.then_some(true), json!({"backlogged":later}), cx);
    }
}

impl Composer {
    pub(crate) fn render_backlog_files(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if self.backlog_attachments.is_empty() { return None; }
        let mut strip = v_flex().gap(px(6.));
        for file in &self.backlog_attachments {
            let (path, name, id) = (file.path.clone(), file.name.clone(), file.id.clone());
            let preview_name = name.clone();
            let picture: AnyElement = if file.media_type.starts_with("image/") {
                img(std::path::PathBuf::from(&path)).size(px(28.)).rounded(px(4.)).into_any_element()
            } else { crate::icons::symbol("doc").with_size(px(20.)).into_any_element() };
            let preview = div().id(SharedString::from(format!("backlog-preview-{id}"))).test_support().role(Role::Button).aria_label(SharedString::from(format!("Preview {name}"))).cursor_pointer()
                .tip(format!("Preview {name}")).child(h_flex().gap(px(8.)).items_center().child(picture).child(v_flex().child(div().max_w(px(230.)).truncate().child(name.clone())).child(format!("{} bytes", file.size))))
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    let Some(app) = this.app.upgrade() else { return };
                    let Some(t) = this.thread_id.as_ref().and_then(|id| app.read(cx).threads.get(id)).cloned() else { return };
                    let side = app.read(cx).side.clone();
                    side.update(cx, |side, cx| side.preview_path(&path, Some(preview_name.clone()), &t, cx));
                }));
            let remove = div().id(SharedString::from(format!("backlog-remove-{id}"))).test_support().role(Role::Button).aria_label(SharedString::from(format!("Remove {name} from this draft"))).cursor_pointer().tip(format!("Remove {name} from this draft")).child("×")
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    if this.backlog_sending { return; }
                    this.backlog_attachments.retain(|f| f.id != id);
                    this.backlog_changed(cx);
                    cx.notify();
                }));
            strip = strip.child(h_flex().gap(px(10.)).items_center().p(px(8.)).rounded(px(8.)).bg(crate::style::primary_opacity(cx,0.05)).text_size(px(12.)).text_color(cx.theme().foreground).child(preview).child(remove));
        }
        Some(strip.into_any_element())
    }

    pub(crate) fn backlog_draft(&self, cx: &App) -> Option<backlog::Draft> {
        let id = self.thread_id.as_ref()?;
        self.app.upgrade()?.read(cx).threads.get(id)?.backlog.clone().filter(|d| d.revision > 0)
    }

    pub(crate) fn save_to_backlog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.thread_id.is_some() || self.creating(cx) { return; }
        if self.copying_picture(cx) {
            if let Some(app) = self.app.upgrade() {
                app.update(cx, |app, cx| app.show_error("Wait for the pictures to finish importing before saving this task.".into(), cx));
            }
            return;
        }
        let (text, images) = self.draft(cx);
        if text.trim().is_empty() && images.is_empty() { return; }
        let stored = self.input.read(cx).value().to_string();
        let Some(app) = self.app.upgrade() else { return };
        if app.read(cx).new_thread.picks.runner.is_some() { return; }
        let text = threadbear_core::composer::message_text(&text, 1);
        app.update(cx, |app, cx| app.create_backlog(text, images, stored, window, cx));
    }

    // One writer per saved prompt. Newer keystrokes are read after each reply;
    // a save never restores old text over the editor while the user types.
    pub(crate) fn backlog_changed(&mut self, cx: &mut Context<Self>) {
        if self.backlog_sending || self.backlog_save.is_some() || self.backlog_draft(cx).is_none() { return; }
        self.backlog_save = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                let snapshot = this.update(cx, |this, cx| {
                    let saved = this.backlog_draft(cx)?;
                    let (text, images) = this.draft(cx);
                    let text = threadbear_core::composer::message_text(&text, 1);
                    if text == saved.text && images == saved.images && this.backlog_attachments == saved.attachments { return None; }
                    Some((this.client.clone(), backlog::save_params(this.thread_id.as_deref()?, &text, &images, &this.backlog_attachments, saved.revision)))
                }).ok().flatten();
                let Some((client, params)) = snapshot else { break };
                let result = call(client, "threads.saveDraft", params.clone()).await;
                let keep_going = this.update(cx, |this, cx| {
                    if let Ok(v) = &result {
                        if let Ok(t) = serde_json::from_value::<ThreadSummary>(v["thread"].clone()) {
                            if let Some(saved) = &t.backlog {
                                let (text, images) = this.draft(cx);
                                let now = backlog::save_params(this.thread_id.as_deref().unwrap_or(""), &text, &images, &this.backlog_attachments, saved.revision);
                                if now["text"] == params["text"] && now["images"] == params["images"] && now["attachments"] == params["attachments"] {
                                    // Update durable image references in place;
                                    // replacing the editor would move its caret.
                                    for ((_, id), image) in Self::chips_in(&this.input, cx).into_iter().zip(&saved.images) {
                                        if let Some(chip) = this.pictures.get_mut(&id) { chip.image = Some(image.clone()); }
                                    }
                                    this.backlog_attachments = saved.attachments.clone();
                                }
                            }
                        }
                    }
                    let Some(app) = this.app.upgrade() else { return false };
                    app.update(cx, |app, cx| match result {
                        Ok(v) => {
                            if let Ok(t) = serde_json::from_value::<ThreadSummary>(v["thread"].clone()) {
                                // Never resurrect a draft after a send or a delete.
                                if app.threads.get(&t.id).is_some_and(|known| known.backlog.as_ref().zip(t.backlog.as_ref()).is_some_and(|(old,new)| old.revision <= new.revision)) {
                                    app.threads.insert(t.id.clone(), std::sync::Arc::new(t));
                                }
                            }
                            cx.notify();
                            app.drafts_changed(cx);
                            true
                        }
                        Err(e) => { app.show_error(e.message, cx); false }
                    })
                }).unwrap_or(false);
                if !keep_going { break; }
            }
            this.update(cx, |this, _| this.backlog_save = None).ok();
        }));
    }

    pub(crate) fn send_backlog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(app) = self.app.upgrade() else { return };
        if !matches!(app.read(cx).status, threadbear_client::runner::Status::Connected { .. }) {
            app.update(cx, |app, cx| app.show_error("Connect to the runner to start this saved task. Your draft is still in the box.".into(), cx));
            return;
        }
        let (text, images) = self.draft(cx);
        if text.trim().is_empty() && images.is_empty() && self.backlog_attachments.is_empty() { return; }
        if self.backlog_sending { return; }
        let Some(id) = self.thread_id.clone() else { return };
        self.backlog_sending = true;
        let saving = self.backlog_save.take();
        let attachments: Vec<Value> = self.backlog_attachments.iter().map(backlog::Attachment::json).collect();
        let params = json!({"threadId":id,"text":threadbear_core::composer::sent_text(&text,1).trim(),
            "images":images.iter().map(crate::composer::image_ref_json).collect::<Vec<_>>(),"attachments":attachments});
        let client = self.client.clone();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            if let Some(saving) = saving { saving.await; }
            let result = call(client, "threads.send", params).await;
            this.update_in(cx, |this, window, cx| {
                this.backlog_sending = false;
                match result {
                    Ok(_) => {
                        this.input.update(cx, |s, cx| s.set_value("", window, cx));
                        this.pictures.clear();
                        this.backlog_attachments.clear();
                        if let Some(app) = this.app.upgrade() {
                            app.update(cx, |app, cx| {
                                if let Some(t) = app.threads.get_mut(&id) { std::sync::Arc::make_mut(t).backlog = None; }
                                app.drafts_changed(cx);
                                cx.notify();
                            });
                        }
                    }
                    Err(e) => if let Some(app) = this.app.upgrade() { app.update(cx, |app, cx| app.show_error(e.message, cx)); },
                }
                cx.notify();
            }).ok();
        }).detach();
    }
}
