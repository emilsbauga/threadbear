// Settings › General › Code review's two lists of reviewers
// (runner/src/lab-reviewers.ts), each reviewer on its model and effort.
// "Every change" (runner.json `labReviewers`) is in Mike's order: the first
// that isn't the thread's own provider and has a login with room reviews,
// so when one runs out for the week the next takes over (Mike, 15 Nov 2026,
// with Codex used up and Grok credits going spare). "Big or risky changes"
// (`labPanel`) all review a big or risky change at once and their findings
// merge. They began as one list with a panel tick on each row, which Mike
// found confusing (19 Nov 2026), so each list now has its own rows, and the
// same provider can be on both on different models or efforts. A provider
// can be on one list more than once on different models, so rows are known
// by their place in their list, not their provider.
//
// Every change's rows drag into order the way the Runners panel's cards do
// (runners_panel.rs); the panel's order means nothing, so it has no grip.
// Every change is the whole list, shown at once (update_runner_settings
// guesses, and puts it back if the runner refuses) and saved as one
// `settings.update`.
use super::{row_with, rows_with_dividers, SettingsWindow, ROW_INSET};
use crate::highlights::{tipped, tipped_as};
use crate::style::px;
use crate::{icons, style};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::Value;
use threadbear_core::composer::{effort_title, model_title};
use threadbear_core::logins::{choice_for, ModelChoice, RunnerLogins};
use threadbear_core::runner_settings::{
    panel_change, reviewer_dropped, reviewers_change, LabReviewer, RunnerSettings,
};

/// Which of Code review's two lists a row is on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ReviewList {
    /// "Every change": in order, the first that can review does.
    Every,
    /// "Big or risky changes": all at once.
    Panel,
}

impl ReviewList {
    /// The `settings.update` change for the whole list.
    fn change(self, list: &[LabReviewer]) -> Value {
        match self {
            ReviewList::Every => reviewers_change(list),
            ReviewList::Panel => panel_change(list),
        }
    }

    /// Its rows' element ids start with this.
    fn id(self) -> &'static str {
        match self {
            ReviewList::Every => "settings-reviewer",
            ReviewList::Panel => "settings-panel-reviewer",
        }
    }
}

/// A reviewer's row being dragged, by its place in the list.
#[derive(Clone)]
struct DraggedReviewer {
    index: usize,
    provider: String,
    name: SharedString,
}

/// What follows the pointer: the reviewer's mark and name, lifted, as a
/// dragged runner card's ghost is.
struct ReviewerGhost {
    provider: String,
    name: SharedString,
}

impl Render for ReviewerGhost {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (bg, lift, edge) = (
            cx.theme().background,
            style::primary_opacity(cx, 0.1),
            style::hairline(cx),
        );
        h_flex()
            .w(px(220.))
            .px(px(10.))
            .py(px(8.))
            .gap(px(10.))
            .items_center()
            .rounded(px(8.))
            .bg(bg)
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .rounded(px(8.))
                    .bg(lift)
                    .border_1()
                    .border_color(edge),
            )
            .shadow_lg()
            .child(
                icons::provider_mark(&self.provider)
                    .with_size(px(14.))
                    .text_color(style::secondary_text(cx)),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(style::label_text(cx))
                    .child(self.name.clone()),
            )
    }
}

/// The models a provider's logins here offer: the first login of it that
/// lists any (they share a provider's list).
fn models_of(logins: &RunnerLogins, provider: &str) -> Vec<ModelChoice> {
    logins
        .accounts
        .iter()
        .filter(|a| a.provider_id() == provider)
        .map(|a| a.models.clone())
        .find(|m| !m.is_empty())
        .unwrap_or_default()
}

fn has_login(logins: &RunnerLogins, provider: &str) -> bool {
    logins.accounts.iter().any(|a| a.provider_id() == provider)
}

/// A model's id as a reviewer names it.
fn model_id(m: &ModelChoice) -> String {
    if m.model.is_empty() {
        m.id.clone()
    } else {
        m.model.clone()
    }
}

/// The rows Add Reviewer offers: one per provider with a login here, in the
/// order the runner lists its providers. One already listed is offered
/// again so it can review on another model too, starting on a model none of
/// its rows has yet (the runner drops an exact repeat, so a second row on
/// the same model would vanish); with every model taken it isn't offered.
fn addable(logins: &RunnerLogins, list: &[LabReviewer]) -> Vec<LabReviewer> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    let ids = logins
        .providers
        .iter()
        .map(|p| p.id.clone())
        .chain(logins.accounts.iter().map(|a| a.provider_id().to_owned()));
    for id in ids {
        if !has_login(logins, &id) || seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let taken: Vec<Option<&str>> = list
            .iter()
            .filter(|r| r.provider == id)
            .map(|r| r.model.as_deref())
            .collect();
        if !taken.contains(&None) {
            out.push(LabReviewer::new(&id));
        } else if let Some(free) = models_of(logins, &id)
            .iter()
            .map(model_id)
            .find(|m| !taken.contains(&Some(m.as_str())))
        {
            out.push(LabReviewer {
                model: Some(free),
                ..LabReviewer::new(&id)
            });
        }
    }
    out
}

/// The list with one reviewer changed.
fn with(
    which: ReviewList,
    list: &[LabReviewer],
    i: usize,
    change: impl FnOnce(&mut LabReviewer),
) -> Value {
    let mut out = list.to_vec();
    if let Some(r) = out.get_mut(i) {
        change(r);
    }
    which.change(&out)
}

/// A model's name on its picker: an OpenCode one from another lab without
/// that lab's prefix ("gemini-4-neon", not "google/gemini-4-neon"), as the
/// row already says it's Gemini.
fn picker_title(title: String, r: &LabReviewer) -> String {
    match title.rsplit_once('/') {
        Some((_, short)) if r.lab().is_some() && !short.is_empty() => short.to_owned(),
        _ => title,
    }
}

/// One of the two lists: its name, a line on what it does, then its rows in
/// a group of their own, as a section's are but without the ⓘ.
fn list_block(
    id: &'static str,
    title: &str,
    about: String,
    rows: Vec<AnyElement>,
    cx: &App,
) -> AnyElement {
    v_flex()
        .id(id)
        .gap(px(8.))
        .child(
            v_flex()
                .px(px(ROW_INSET))
                .gap(px(2.))
                .child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(16.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(title.to_owned()),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .text_color(style::secondary_text(cx))
                        .child(about),
                ),
        )
        .child(
            div()
                .rounded(px(12.))
                .bg(style::primary_opacity(cx, 0.03))
                .child(rows_with_dividers(rows, cx)),
        )
        .into_any_element()
}

impl SettingsWindow {
    /// Code review's two lists, while reviews are on, or none from a runner
    /// from before them.
    pub(super) fn review_lists(
        &self,
        settings: &RunnerSettings,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let mut out = Vec::new();
        if let Some(list) = &settings.lab_reviewers {
            let rows = self.reviewer_rows(ReviewList::Every, list, cx);
            out.push(list_block(
                "settings-reviewers-every",
                "Every change",
                "One reviewer. If it's out of room, the next one down.".into(),
                rows,
                cx,
            ));
        }
        if let Some(list) = &settings.lab_panel {
            let rows = self.reviewer_rows(ReviewList::Panel, list, cx);
            let about = format!("All of these review at once: {}+ lines, or code touching sign-in, payments or secrets.", settings.lab_panel_lines);
            out.push(list_block(
                "settings-reviewers-panel",
                "Big or risky changes",
                about,
                rows,
                cx,
            ));
        }
        out
    }

    /// A list's rows, then Add Reviewer when there's a provider with a login
    /// to add.
    fn reviewer_rows(
        &self,
        which: ReviewList,
        list: &[LabReviewer],
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let Some(app) = self.app.upgrade() else {
            return Vec::new();
        };
        let logins = app.read(cx).logins.clone();
        let mut rows: Vec<AnyElement> = list
            .iter()
            .enumerate()
            .map(|(i, r)| self.reviewer_row(which, i, r, list, &logins, cx))
            .collect();
        let more = addable(&logins, list);
        if !more.is_empty() {
            let choices: Vec<(String, bool, Value)> = more
                .into_iter()
                .map(|r| {
                    let title = logins.provider_title(&r.provider);
                    let mut next = list.to_vec();
                    next.push(r);
                    (title, false, which.change(&next))
                })
                .collect();
            let tip = match which {
                ReviewList::Every => "Add a provider you have a login for to the end of the list. One already listed can go on again with another model",
                ReviewList::Panel => "Add a provider you have a login for. One already listed can go on again with another model",
            };
            let add = self.menu_owned(
                format!("{}-add", which.id()),
                "Add Reviewer".into(),
                None,
                tip.into(),
                choices,
                cx,
            );
            rows.push(row_with(
                h_flex().child(add).into_any_element(),
                div().into_any_element(),
                cx,
            ));
        } else if list.is_empty() {
            rows.push(row_with(
                div()
                    .text_color(style::tertiary_label(cx))
                    .child("No reviewers, and no other login to add")
                    .into_any_element(),
                div().into_any_element(),
                cx,
            ));
        }
        rows
    }

    /// A reviewer's row: its name with its model and effort right after it
    /// (Mike, 19 Nov 2026: the name "so far away from the model and the
    /// effort level" was odd), and the minus out at the end.
    #[expect(
        clippy::too_many_lines,
        reason = "baselined at 203 lines when the lint was turned on (20 Nov 2026); split it when it's next worked on"
    )]
    fn reviewer_row(
        &self,
        which: ReviewList,
        i: usize,
        r: &LabReviewer,
        list: &[LabReviewer],
        logins: &RunnerLogins,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (secondary, tertiary) = (style::secondary_text(cx), style::tertiary_label(cx));
        let key = which.id();
        let provider = r.provider.clone();
        let provider_name = logins.provider_title(&provider);
        // OpenCode on another lab's model goes by that lab ("Gemini").
        let name = r.lab().map_or_else(|| provider_name.clone(), str::to_owned);
        let here = has_login(logins, &provider);
        let movable = which == ReviewList::Every && list.len() > 1;

        let mut group = h_flex().gap(px(8.)).items_center().min_w_0();
        if movable {
            group = group.child(
                tipped_as(
                    div()
                        .id(SharedString::from(format!("{key}-handle-{i}")))
                        .flex_none()
                        .w(px(13.))
                        .h(px(17.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .cursor_grab(),
                    "Drag to change the order",
                    gpui_kit::Role::GenericContainer,
                )
                .child(
                    icons::symbol("line.3.horizontal")
                        .with_size(px(12.))
                        .text_color(tertiary),
                ),
            );
        }
        // Wide enough for the usual names, so their pickers line up.
        let mut title = h_flex()
            .flex_none()
            .min_w(px(46.))
            .gap(px(4.))
            .items_center()
            .whitespace_nowrap()
            .child(
                div()
                    .when(!here, |s| s.text_color(tertiary))
                    .child(name.clone()),
            );
        if r.lab().is_some() {
            title = title.child(
                div()
                    .text_color(tertiary)
                    .child(format!("· {provider_name}")),
            );
        }
        group = group
            .child(
                div().flex_none().w(px(18.)).flex().justify_center().child(
                    icons::provider_mark(&provider)
                        .with_size(px(14.))
                        .text_color(if here { secondary } else { tertiary }),
                ),
            )
            .child(title);
        if !here {
            // Kept in the list (the login may come back), but passed over.
            group = group.child(
                tipped(
                    div()
                        .id(SharedString::from(format!("{key}-missing-{i}")))
                        .text_size(px(11.))
                        .text_color(tertiary)
                        .whitespace_nowrap(),
                    format!("There's no {provider_name} login on this runner, so it's passed over"),
                )
                .child("No login"),
            );
        }

        let models = models_of(logins, &provider);
        let mut pickers = h_flex().ml(px(4.)).gap(px(6.)).items_center().flex_none();
        if here && !models.is_empty() {
            let shown = r.model.as_deref().map(|m| {
                choice_for(m, &models).map_or_else(
                    || model_title(Some(m)),
                    |c| {
                        if c.title.is_empty() {
                            model_title(Some(m))
                        } else {
                            c.title.clone()
                        }
                    },
                )
            });
            // A new model keeps the effort only if it offers it; otherwise the
            // row would show a level the review never runs at (Grok's
            // review, 15 Nov 2026), as create drops it (checkSettings).
            let keeps = |model: Option<&str>| {
                r.effort
                    .as_ref()
                    .filter(|e| logins.effort_levels(model, &models, &provider).contains(e))
                    .cloned()
            };
            let default_effort = keeps(None);
            let mut choices: Vec<(String, bool, Value)> = vec![(
                "Default".into(),
                r.model.is_none(),
                with(which, list, i, |x| {
                    x.model = None;
                    x.effort = default_effort;
                }),
            )];
            for m in &models {
                let id = model_id(m);
                let title = if m.title.is_empty() {
                    model_title(Some(&id))
                } else {
                    m.title.clone()
                };
                let picked = r.model.as_deref() == Some(id.as_str())
                    || r.model.as_deref() == Some(m.id.as_str());
                let effort = keeps(Some(&id));
                choices.push((
                    title,
                    picked,
                    with(which, list, i, |x| {
                        x.model = Some(id.clone());
                        x.effort = effort;
                    }),
                ));
            }
            let label = shown.map_or_else(|| "Default".into(), |t| picker_title(t, r));
            pickers = pickers.child(self.menu_owned(
                format!("{key}-model-{i}"),
                label,
                None,
                format!("The model {name} reviews on"),
                choices,
                cx,
            ));
        }
        let levels = logins.effort_levels(r.model.as_deref(), &models, &provider);
        if here && !levels.is_empty() {
            // No effort named is high, as the runner starts it.
            let current = r.effort.clone().unwrap_or_else(|| "high".into());
            let choices: Vec<(String, bool, Value)> = levels
                .iter()
                .map(|l| {
                    let level = l.clone();
                    (
                        effort_title(l),
                        *l == current,
                        with(which, list, i, |x| x.effort = Some(level)),
                    )
                })
                .collect();
            pickers = pickers.child(self.menu_owned(
                format!("{key}-effort-{i}"),
                effort_title(&current),
                None,
                format!("How hard {name} thinks while it reviews"),
                choices,
                cx,
            ));
        }
        group = group.child(pickers);

        let mut rest = list.to_vec();
        rest.remove(i);
        let remove_tip = match which {
            ReviewList::Every => format!("Take {name} off the list"),
            ReviewList::Panel => format!("Take {name} off Big or risky changes"),
        };
        let remove = self.icon_button_owned(
            format!("{key}-remove-{i}"),
            "minus.circle",
            remove_tip,
            cx,
            move |this, _, cx| this.update(which.change(&rest), cx),
        );

        let row = row_with(group.into_any_element(), remove, cx);
        let shell = div()
            .id(SharedString::from(format!("{key}-{i}")))
            .w_full()
            .rounded(px(8.));
        if !movable {
            return shell.child(row).into_any_element();
        }
        // A drop on a row puts the dragged one in its place; the slot shows
        // dashed meanwhile, as on the Runners panel.
        let slot = style::tertiary_label(cx);
        let order = list.to_vec();
        shell
            .on_drag(
                DraggedReviewer {
                    index: i,
                    provider,
                    name: name.into(),
                },
                |d, _, _, cx| {
                    cx.new(|_| ReviewerGhost {
                        provider: d.provider.clone(),
                        name: d.name.clone(),
                    })
                },
            )
            .drag_over::<DraggedReviewer>(move |s, _, _, _| {
                s.border_1()
                    .border_dashed()
                    .border_color(slot)
                    .m(gpui_kit::px(-1.))
            })
            .on_drop(cx.listener(move |this, d: &DraggedReviewer, _, cx| {
                if let Some(next) = reviewer_dropped(&order, d.index, i) {
                    this.update(reviewers_change(&next), cx);
                }
            }))
            .child(row)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    // Not super::*: gpui's prelude has a `test` of its own.
    use super::{addable, models_of, picker_title};
    use serde_json::json;
    use threadbear_core::logins::RunnerLogins;
    use threadbear_core::runner_settings::LabReviewer;

    fn logins() -> RunnerLogins {
        RunnerLogins::from_hello(&json!({
            "accounts": [
                { "id": "claude-main", "provider": "claude" },
                { "id": "codex-main", "provider": "codex", "models": [{ "id": "gpt-6.1-sol" }] },
                { "id": "grok-main", "provider": "grok" },
            ],
            "providers": [{ "id": "claude" }, { "id": "codex" }, { "id": "grok" }, { "id": "cursor" }],
        }))
    }

    #[test]
    fn add_offers_providers_with_a_login_on_a_model_not_listed() {
        let list = vec![LabReviewer::new("codex"), LabReviewer::new("claude")];
        let offered = |list: &[LabReviewer]| {
            addable(&logins(), list)
                .into_iter()
                .map(|r| (r.provider, r.model))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            offered(&list),
            vec![("codex".into(), Some("gpt-6.1-sol".into())), ("grok".into(), None)],
            "Codex again on its other model; Claude has no other model to go on; Cursor has no login here"
        );
        let both = vec![
            LabReviewer::new("codex"),
            LabReviewer {
                model: Some("gpt-6.1-sol".into()),
                ..LabReviewer::new("codex")
            },
        ];
        assert_eq!(
            offered(&both),
            vec![("claude".into(), None), ("grok".into(), None)],
            "every Codex model is taken"
        );
        let picked = vec![LabReviewer {
            model: Some("gpt-6.1-sol".into()),
            ..LabReviewer::new("codex")
        }];
        assert_eq!(
            offered(&picked)[1],
            ("codex".into(), None),
            "the default is free while no Codex row is on it"
        );
        assert_eq!(models_of(&logins(), "codex").len(), 1);
        assert!(models_of(&logins(), "grok").is_empty());
    }

    #[test]
    fn an_opencode_model_from_another_lab_drops_its_prefix() {
        let gemini = LabReviewer {
            model: Some("google/gemini-4-neon".into()),
            ..LabReviewer::new("opencode")
        };
        assert_eq!(
            picker_title("google/gemini-4-neon".into(), &gemini),
            "gemini-4-neon"
        );
        let glm = LabReviewer {
            model: Some("zai/glm-5".into()),
            ..LabReviewer::new("opencode")
        };
        assert_eq!(
            picker_title("zai/glm-5".into(), &glm),
            "zai/glm-5",
            "no lab to name it by, so the prefix says whose it is"
        );
        assert_eq!(
            picker_title("GPT-6.1-Sol".into(), &LabReviewer::new("codex")),
            "GPT-6.1-Sol"
        );
    }
}
