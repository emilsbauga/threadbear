// Settings › Models › Small jobs' provider order (`runner.json` `models.providers`).
// Inside the chosen pool, small jobs (titles, the librarian, "wake when") try
// providers from top to bottom: Claude, then Codex, then the pool's remaining
// small-job providers by default, or Mike's custom order once dragged, trimmed,
// or added to. Dragging a row onto another works the same way as Code review's
// "Every change" list (`reviewers.rs`).
use super::{row_with, rows_with_dividers, SettingsWindow, ROW_INSET};
use crate::highlights::{tipped, tipped_as};
use crate::style::px;
use crate::{icons, style};
use gpui_kit::component::{h_flex, v_flex, ActiveTheme as _, Sizable as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::Value;
use threadbear_core::logins::RunnerLogins;
use threadbear_core::runner_settings::{
    default_small_job_providers, provider_dropped, small_job_providers_change, RunnerSettings,
};

#[derive(Clone)]
struct DraggedSmallJobProvider {
    index: usize,
    provider: String,
    name: SharedString,
}

struct SmallJobProviderGhost {
    provider: String,
    name: SharedString,
}

impl Render for SmallJobProviderGhost {
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

/// The `smallJobs`-capable providers present in `pool_id`, in the order the
/// pool's `account_ids` first name them.
fn pool_small_job_providers(logins: &RunnerLogins, pool_id: &str, small: &[String]) -> Vec<String> {
    let Some(pool) = logins.pools.iter().find(|p| p.id == pool_id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for account_id in &pool.account_ids {
        let Some(account) = logins.account(account_id) else {
            continue;
        };
        let provider = account.provider_id();
        if small.iter().any(|p| p == provider) && !out.iter().any(|p| p == provider) {
            out.push(provider.to_owned());
        }
    }
    out
}

/// The `smallJobs`-capable providers with a login on this runner that aren't in
/// `list` yet: ones in the selected pool first, then any other on this runner.
fn addable_providers(
    logins: &RunnerLogins,
    in_pool: &[String],
    small: &[String],
    list: &[String],
) -> Vec<String> {
    let mut out = Vec::new();
    for p in in_pool {
        if !list.contains(p) && !out.contains(p) {
            out.push(p.clone());
        }
    }
    let runner_ids = logins
        .providers
        .iter()
        .map(|p| p.id.as_str())
        .chain(logins.accounts.iter().map(|a| a.provider_id()));
    for id in runner_ids {
        let has_login = logins.accounts.iter().any(|a| a.provider_id() == id);
        if has_login
            && small.iter().any(|p| p == id)
            && !list.iter().any(|p| p == id)
            && !out.iter().any(|p| p == id)
        {
            out.push(id.to_owned());
        }
    }
    out
}

/// Count of distinct `smallJobs`-capable providers that have at least one login
/// on this runner (across all pools).
fn runner_small_job_provider_count(logins: &RunnerLogins, small: &[String]) -> usize {
    let mut seen: Vec<&str> = Vec::new();
    for a in &logins.accounts {
        let p = a.provider_id();
        if small.iter().any(|s| s == p) && !seen.contains(&p) {
            seen.push(p);
        }
    }
    seen.len()
}

impl SettingsWindow {
    /// Small jobs' provider order block, under the Small jobs pool picker.
    /// None when the runner is too old to support `models.providers`, or when
    /// Small jobs are turned off (`pool == None`).
    pub(super) fn small_jobs_provider_order(
        &self,
        settings: &RunnerSettings,
        logins: &RunnerLogins,
        small: &[String],
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !settings.providers_supported {
            return None;
        }
        let pool_id = settings.pool.as_deref()?;
        let in_pool = pool_small_job_providers(logins, pool_id, small);
        let custom = settings.providers.is_some();
        let list: Vec<String> = match &settings.providers {
            Some(explicit) => explicit.clone(),
            None => default_small_job_providers(&in_pool),
        };
        if list.is_empty() && !custom {
            return None;
        }

        let mut rows: Vec<AnyElement> = list
            .iter()
            .enumerate()
            .map(|(i, p)| self.small_job_provider_row(i, p, &list, &in_pool, logins, cx))
            .collect();

        if list.is_empty() {
            rows.push(row_with(
                div()
                    .text_color(style::tertiary_label(cx))
                    .child("No providers — add one or reset to default")
                    .into_any_element(),
                div().into_any_element(),
                cx,
            ));
        }

        let more = addable_providers(logins, &in_pool, small, &list);
        let mut footer_left = h_flex().gap(px(8.)).items_center();
        let mut has_footer = false;
        if !more.is_empty() {
            let choices: Vec<(String, bool, Value)> = more
                .into_iter()
                .map(|p| {
                    let title = logins.provider_title(&p);
                    let mut next = list.clone();
                    next.push(p);
                    (title, false, small_job_providers_change(Some(&next)))
                })
                .collect();
            let add = self.menu_owned(
                "settings-small-jobs-provider-add".into(),
                "Add Provider".into(),
                None,
                "Add a provider to the end of the small-job fallback list".into(),
                choices,
                cx,
            );
            footer_left = footer_left.child(add);
            has_footer = true;
        }
        let footer_right = if custom {
            has_footer = true;
            self.button(
                "settings-small-jobs-provider-reset",
                "Reset",
                "Go back to the automatic order for this pool (Claude, then Codex, then the rest)",
                cx,
                |this, _, cx| this.update(small_job_providers_change(None), cx),
            )
        } else {
            div().into_any_element()
        };
        if has_footer {
            rows.push(row_with(footer_left.into_any_element(), footer_right, cx));
        }

        let about = if !custom
            && in_pool.len() <= 1
            && runner_small_job_provider_count(logins, small) > 1
        {
            let only = in_pool
                .first()
                .map(|p| logins.provider_title(p))
                .unwrap_or_else(|| "one provider".into());
            format!("Only {only} logins are in this pool. Pick a pool with other providers to fall back to them.")
        } else if custom {
            "Tried from top to bottom inside this pool. Drag to change the order.".into()
        } else {
            "Tried from top to bottom inside this pool (Claude, then Codex, then the rest). Drag to change the order.".into()
        };

        Some(
            v_flex()
                .id("settings-small-jobs-providers")
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
                                .child("Provider order"),
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
                .into_any_element(),
        )
    }

    fn small_job_provider_row(
        &self,
        i: usize,
        provider: &str,
        list: &[String],
        in_pool: &[String],
        logins: &RunnerLogins,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (secondary, tertiary) = (style::secondary_text(cx), style::tertiary_label(cx));
        let key = "settings-small-jobs-provider";
        let name = logins.provider_title(provider);
        let here = in_pool.iter().any(|p| p == provider);
        let movable = list.len() > 1;

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
        group = group
            .child(
                div().flex_none().w(px(18.)).flex().justify_center().child(
                    icons::provider_mark(provider)
                        .with_size(px(14.))
                        .text_color(if here { secondary } else { tertiary }),
                ),
            )
            .child(
                div()
                    .whitespace_nowrap()
                    .when(!here, |s| s.text_color(tertiary))
                    .child(name.clone()),
            );
        if !here {
            group = group.child(
                tipped(
                    div()
                        .id(SharedString::from(format!("{key}-missing-{i}")))
                        .text_size(px(11.))
                        .text_color(tertiary)
                        .whitespace_nowrap(),
                    format!("This pool has no {name} login, so it's passed over"),
                )
                .child("Not in pool"),
            );
        }

        let mut rest = list.to_vec();
        rest.remove(i);
        let remove = self.icon_button_owned(
            format!("{key}-remove-{i}"),
            "minus.circle",
            format!("Don't use {name} for small jobs"),
            cx,
            move |this, _, cx| this.update(small_job_providers_change(Some(&rest)), cx),
        );

        let row = row_with(group.into_any_element(), remove, cx);
        let shell = div()
            .id(SharedString::from(format!("{key}-{i}")))
            .w_full()
            .rounded(px(8.));
        if !movable {
            return shell.child(row).into_any_element();
        }
        let slot = style::tertiary_label(cx);
        let order = list.to_vec();
        let provider_owned = provider.to_owned();
        shell
            .on_drag(
                DraggedSmallJobProvider {
                    index: i,
                    provider: provider_owned,
                    name: name.into(),
                },
                |d, _, _, cx| {
                    cx.new(|_| SmallJobProviderGhost {
                        provider: d.provider.clone(),
                        name: d.name.clone(),
                    })
                },
            )
            .drag_over::<DraggedSmallJobProvider>(move |s, _, _, _| {
                s.border_1()
                    .border_dashed()
                    .border_color(slot)
                    .m(gpui_kit::px(-1.))
            })
            .on_drop(
                cx.listener(move |this, d: &DraggedSmallJobProvider, _, cx| {
                    if let Some(next) = provider_dropped(&order, d.index, i) {
                        this.update(small_job_providers_change(Some(&next)), cx);
                    }
                }),
            )
            .child(row)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{addable_providers, pool_small_job_providers, runner_small_job_provider_count};
    use serde_json::json;
    use threadbear_core::logins::RunnerLogins;

    fn logins() -> RunnerLogins {
        RunnerLogins::from_hello(&json!({
            "accounts": [
                { "id": "claude-1", "provider": "claude" },
                { "id": "codex-main", "provider": "codex" },
                { "id": "grok-main", "provider": "grok" },
                { "id": "cursor-main", "provider": "cursor" },
            ],
            "pools": [
                { "id": "main", "title": "Main", "accountIds": ["claude-1", "cursor-main", "grok-main", "codex-main"] },
                { "id": "claude", "title": "Claude", "accountIds": ["claude-1"] },
            ],
            "providers": [
                { "id": "claude" },
                { "id": "codex" },
                { "id": "cursor" },
                { "id": "grok" },
                { "id": "opencode" },
            ],
        }))
    }

    #[test]
    fn pool_and_addable_providers_filter_to_small_job_logins() {
        let l = logins();
        let small: Vec<String> = vec![
            "claude".into(),
            "codex".into(),
            "grok".into(),
            "opencode".into(),
        ];
        let in_main = pool_small_job_providers(&l, "main", &small);
        assert_eq!(in_main, vec!["claude", "grok", "codex"]);
        assert_eq!(runner_small_job_provider_count(&l, &small), 3);

        // Removing grok offers grok (in pool) and skips opencode (no login) and cursor (not smallJobs).
        let list = vec!["claude".into(), "codex".into()];
        assert_eq!(addable_providers(&l, &in_main, &small, &list), vec!["grok"]);

        // On the claude-only pool, codex and grok are still addable from the runner so Mike can pre-order them.
        let in_claude = pool_small_job_providers(&l, "claude", &small);
        assert_eq!(in_claude, vec!["claude"]);
        assert_eq!(
            addable_providers(&l, &in_claude, &small, &in_claude),
            vec!["codex", "grok"]
        );
    }
}
