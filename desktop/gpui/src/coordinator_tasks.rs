// Both views read the same board. Pending controls are keyed by project and
// target, so a click in one view also disables its counterpart in the other.
use crate::app::Threadbear;
use crate::call;
use crate::coordinators::Tab;
use crate::spinner::Spinner;
use crate::style::{self, px};
use crate::tips::Tip as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::date_picker::{DatePicker, DatePickerEvent, DatePickerState};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, Selectable as _, Sizable as _,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use threadbear_core::chrono::{DateTime, Local, NaiveDate};
use threadbear_core::coordinators::tasks::{
    self, Group, Highlight, Kind, Mark, Owner, PostponeUntil, State, TaskAction, TaskBoard,
    TaskDue, WorkTask,
};
use threadbear_core::coordinators::Coordinator;
use threadbear_core::inbox::OpenAsk;

#[derive(Default)]
pub(crate) struct BoardUi {
    selected: Option<String>,
    list_scroll: ScrollHandle,
    detail_scroll: ScrollHandle,
    add: Option<AddInput>,
    added: bool,
    undo: Option<String>,
    editor: Option<DecisionEditor>,
    pending: HashSet<Target>,
}

struct AddInput {
    input: Entity<InputState>,
    _enter: Subscription,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Surface {
    Tasks,
    Highlights,
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Target {
    Task(String),
    WorkItem(String),
    Add,
}

struct DecisionEditor {
    surface: Surface,
    task: String,
    asks_seq: Option<u64>,
    mode: EditMode,
}

enum EditMode {
    Postpone,
    Date {
        picker: Entity<DatePickerState>,
        _change: Subscription,
    },
    AfterTask,
    Reply {
        input: Entity<InputState>,
        _enter: Subscription,
    },
}

impl Threadbear {
    pub(crate) fn task_details_bounds(&self, project: &str) -> Option<[f32; 4]> {
        if self.coordinators.tab != Tab::Tasks {
            return None;
        }
        let bounds = self
            .coordinators
            .task_boards
            .get(project)?
            .detail_scroll
            .bounds();
        Some([
            bounds.left().into(),
            bounds.top().into(),
            bounds.right().into(),
            bounds.bottom().into(),
        ])
    }

    pub(crate) fn task_request_sending(&self, project: &str) -> bool {
        self.coordinators
            .task_boards
            .get(project)
            .is_some_and(|ui| ui.pending.contains(&Target::Add))
    }

    pub(crate) fn open_coordinator_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        let changed = self.coordinators.tab != tab;
        self.coordinators.tab = tab;
        self.close_subagent(cx);
        if let Some(project) = self
            .projects
            .open
            .as_deref()
            .filter(|_| changed && tab == Tab::Tasks)
        {
            self.refresh_task_board(project, cx);
        }
        cx.notify();
    }

    pub(crate) fn refresh_task_board(&self, project: &str, cx: &mut Context<Self>) {
        let Some(before) = self.coordinator_for_project(project).cloned() else {
            return;
        };
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = call(
                client,
                "coordinators.get",
                json!({"projectId":before.project_id}),
            )
            .await;
            if let Ok(value) = result {
                this.update(cx, |this, cx| {
                    this.apply_task_board(&before, &value, cx);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn apply_task_board(&mut self, before: &Coordinator, value: &Value, cx: &mut Context<Self>) {
        let Some(current) = self.coordinator_for_project(&before.project_id) else {
            return;
        };
        let row = &value["coordinator"];
        // A reply can arrive after an update for this project. Prefer the
        // broadcast when both report the same millisecond and disagree.
        if row["projectId"].as_str() == Some(&before.project_id)
            && row["threadId"].as_str() == Some(&current.thread_id)
            && (current == before
                || row["updatedAt"]
                    .as_str()
                    .is_some_and(|at| at > current.updated_at.as_str()))
        {
            self.replace_coordinator(row, cx);
        }
    }

    fn change_task_board(
        &mut self,
        project: &str,
        target: Target,
        (method, params): (&'static str, Value),
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.connected() {
            return;
        }
        let Some(before) = self.coordinator_for_project(project).cloned() else {
            return;
        };
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        if !ui.pending.insert(target.clone()) {
            return;
        }
        if target == Target::Add {
            ui.added = false;
        }
        let client = self.client.clone();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = call(client, method, params).await;
            this.update_in(cx, |this, window, cx| {
                if let Ok(value) = &result {
                    this.apply_task_board(&before, value, cx);
                }
                if let Some(ui) = this.coordinators.task_boards.get_mut(&before.project_id) {
                    ui.pending.remove(&target);
                    if result.is_ok() {
                        match &target {
                            Target::Add => {
                                if let Some(add) = &ui.add {
                                    add.input.update(cx, |s, cx| s.set_value("", window, cx));
                                }
                                ui.added = true;
                            }
                            Target::Task(id) => {
                                if ui.editor.as_ref().is_some_and(|e| &e.task == id) {
                                    ui.editor = None;
                                }
                                if method == "coordinators.closeTask" {
                                    ui.undo = Some(id.clone());
                                } else if ui.undo.as_ref() == Some(id) {
                                    ui.undo = None;
                                }
                            }
                            Target::WorkItem(_) => {}
                        }
                    }
                }
                if let Err(error) = result {
                    this.show_error(error.message, cx);
                    this.refresh_task_board(&before.project_id, cx);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn task_action(
        &mut self,
        project: &str,
        task: &str,
        action: TaskAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.change_task_board(
            project,
            Target::Task(task.to_owned()),
            action.request(project, task),
            window,
            cx,
        );
    }

    fn send_task_request(&mut self, project: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(add) = self
            .coordinators
            .task_boards
            .get(project)
            .and_then(|ui| ui.add.as_ref())
        else {
            return;
        };
        let text = add.input.read(cx).value();
        let text = text.trim();
        if !text.is_empty() {
            self.change_task_board(
                project,
                Target::Add,
                tasks::add_request(project, text),
                window,
                cx,
            );
        }
    }

    pub(crate) fn render_coordinator_tasks(
        &mut self,
        coordinator: &Coordinator,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(board) = coordinator.task_board.as_deref() else {
            return div()
                .p(px(24.))
                .text_color(style::secondary_text(cx))
                .child("Tasks are available when the runner supports the task board.")
                .into_any_element();
        };
        let project = &coordinator.project_id;
        let ui = self
            .coordinators
            .task_boards
            .entry(project.clone())
            .or_default();
        let add =
            ui.add.get_or_insert_with(|| {
                let input = cx.new(|cx| {
                    InputState::new(window, cx).placeholder("Add a request for the coordinator")
                });
                let project = project.clone();
                let enter =
                    cx.subscribe_in(&input, window, move |this, input, event, window, cx| {
                        match event {
                            InputEvent::PressEnter { .. } => {
                                this.send_task_request(&project, window, cx)
                            }
                            InputEvent::Change => {
                                if let Some(ui) = this.coordinators.task_boards.get_mut(&project) {
                                    if !input.read(cx).value().trim().is_empty() {
                                        ui.added = false;
                                    }
                                }
                                cx.notify();
                            }
                            _ => {}
                        }
                    });
                AddInput {
                    input,
                    _enter: enter,
                }
            });
        let input = add.input.clone();
        let groups = board.groups();
        let selected = ui
            .selected
            .as_deref()
            .and_then(|id| board.task(id))
            .or_else(|| {
                groups
                    .iter()
                    .filter(|g| g.item.is_none_or(|item| !item.collapsed))
                    .find_map(|g| g.roots.first().map(|row| row.task))
            });

        let ui = &self.coordinators.task_boards[project];
        let busy = ui.pending.contains(&Target::Add);
        let connected = self.connected();
        let blank = input.read(cx).value().trim().is_empty();
        let project_id = project.clone();
        let add = h_flex()
            .w_full()
            .gap(px(8.))
            .children(busy.then(|| spinner(cx)))
            .child(
                div()
                    .id("coordinator-task-add-input")
                    .flex_1()
                    .min_w_0()
                    .tip("Add a request for the coordinator")
                    .child(Input::new(&input).small().disabled(busy || !connected)),
            )
            .child(
                Button::new("coordinator-request-add")
                    .small()
                    .primary()
                    .label(if busy { "Sending…" } else { "Add" })
                    .loading(busy)
                    .disabled(busy || !connected || blank)
                    .tooltip("Send a request to the coordinator")
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.send_task_request(&project_id, window, cx)
                    })),
            );
        let list = self.task_groups(project, board, &groups, selected, cx);
        let details = match selected {
            Some(task) => self.render_task_detail(coordinator, board, task, cx),
            None => muted("Select a task to see its details.", cx).into_any_element(),
        };
        let legend = h_flex()
            .flex_wrap()
            .gap(px(9.))
            .children(Mark::ALL.map(|mark| {
                h_flex()
                    .gap(px(4.))
                    .text_size(px(11.))
                    .text_color(style::secondary_text(cx))
                    .child(mark_icon(mark, cx))
                    .child(mark.label())
            }));
        let narrow =
            self.coordinators.home_width.get() > 0. && self.coordinators.home_width.get() < 570.;
        let list = v_flex()
            .min_w_0()
            .min_h_0()
            .when(narrow, |el| el.w_full().flex_1())
            .when(!narrow, |el| {
                el.w(relative(0.43)).max_w(px(400.)).flex_none()
            })
            .child(
                div()
                    .id("coordinator-task-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&ui.list_scroll)
                    .child(list),
            )
            .child(div().flex_none().pt(px(8.)).child(legend));
        let details = div()
            .id("coordinator-task-detail")
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&ui.detail_scroll)
            .bg(style::primary_opacity(cx, 0.035))
            .rounded(px(10.))
            .p(px(16.))
            .child(details);
        v_flex()
            .size_full()
            .gap(px(12.))
            .p(px(16.))
            .child(div().flex_none().child(add).when(ui.added, |el| {
                el.child(
                    div()
                        .pt(px(4.))
                        .child(muted("Request sent to the coordinator", cx)),
                )
            }))
            .child(
                div()
                    .flex()
                    .when(narrow, |el| el.flex_col())
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .gap(px(14.))
                    .child(list)
                    .child(details),
            )
            .into_any_element()
    }

    fn task_groups(
        &self,
        project: &str,
        board: &TaskBoard,
        groups: &[Group<'_>],
        selected: Option<&WorkTask>,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut list = v_flex().w_full().gap(px(12.));
        let ui = &self.coordinators.task_boards[project];
        let connected = self.connected();
        for group in groups {
            let mut section = v_flex().w_full().gap(px(2.));
            if let Some(item) = group.item {
                let progress = group.progress();
                let busy = ui.pending.contains(&Target::WorkItem(item.id.clone()));
                let collapsed = item.collapsed;
                let item_id = item.id.clone();
                let group_title = item.title.clone();
                let project = project.to_owned();
                let tip = format!(
                    "{} {}",
                    if collapsed { "Expand" } else { "Collapse" },
                    item.title
                );
                let header = h_flex()
                    .id(id("work-item", &item.id))
                    .role(Role::Button)
                    .gap(px(6.))
                    .w_full()
                    .min_h(px(25.))
                    .px(px(6.))
                    .rounded(px(5.))
                    .text_size(px(12.))
                    .text_color(style::secondary_text(cx))
                    .child(if busy {
                        spinner(cx)
                    } else {
                        div()
                            .w(px(12.))
                            .child(if collapsed { "▸" } else { "▾" })
                            .into_any_element()
                    })
                    .child(div().flex_1().min_w_0().truncate().child(group_title))
                    .child(
                        div()
                            .flex_none()
                            .child(format!("{} of {} done", progress.done, progress.total)),
                    )
                    .when(!busy && connected, |el| {
                        el.cursor_pointer()
                            .hover(|s| s.bg(style::hover_fill(cx)))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let request =
                                    tasks::collapse_request(&project, &item_id, !collapsed);
                                this.change_task_board(
                                    &project,
                                    Target::WorkItem(item_id.clone()),
                                    request,
                                    window,
                                    cx,
                                );
                            }))
                    });
                section = section.child(crate::highlights::tipped(header, tip));
            } else if !board.work_items.is_empty() {
                section = section.child(section_label("Ungrouped", style::secondary_text(cx)));
            }
            if group.item.is_none_or(|item| !item.collapsed) {
                for row in &group.roots {
                    for (task, subtask) in std::iter::once((row.task, false))
                        .chain(row.children.iter().map(|task| (*task, true)))
                    {
                        section = section
                            .child(self.task_list_row(project, board, task, selected, subtask, cx));
                    }
                }
            }
            list = list.child(section);
        }
        if groups.is_empty() {
            list = list.child(muted("No tasks yet", cx));
        }

        list
    }

    fn task_list_row(
        &self,
        project: &str,
        board: &TaskBoard,
        task: &WorkTask,
        selected: Option<&WorkTask>,
        subtask: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let active = selected.is_some_and(|selected| selected.id == task.id);
        let title = task.title.clone();
        let label = title.clone();
        let task_id = task.id.clone();
        let project = project.to_owned();
        let due = task.due.as_ref().map(short_due);
        crate::highlights::tipped(
            h_flex()
                .id(id("task-row", &task.id))
                .role(Role::Button)
                .w_full()
                .min_h(px(28.))
                .gap(px(7.))
                .px(px(7.))
                .when(subtask, |el| el.pl(px(24.)))
                .rounded(px(5.))
                .cursor_pointer()
                .text_size(px(13.))
                .when(active, |el| el.bg(style::accent(cx).opacity(0.22)))
                .when(!active, |el| el.hover(|el| el.bg(style::hover_fill(cx))))
                .child(mark_icon(task.mark(), cx))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .when(task.state == State::Done && !active, |el| {
                            el.text_color(style::secondary_text(cx))
                        })
                        .child(title),
                )
                .children(due.map(|due| {
                    div()
                        .flex_none()
                        .text_size(px(11.))
                        .text_color(style::secondary_text(cx))
                        .child(due)
                })),
            format!(
                "Show task {label}{}",
                task.due
                    .as_ref()
                    .map_or_else(String::new, |due| format!(" · {}", due_label(board, due)))
            ),
        )
        .on_click(cx.listener(move |this, _, _, cx| {
            this.select_board_task(&project, &task_id, cx);
        }))
        .into_any_element()
    }

    fn select_board_task(&mut self, project: &str, task: &str, cx: &mut Context<Self>) {
        let ui = self
            .coordinators
            .task_boards
            .entry(project.to_owned())
            .or_default();
        if ui.selected.as_deref() != Some(task) {
            ui.selected = Some(task.to_owned());
            ui.detail_scroll.set_offset(Point::default());
        }
        cx.notify();
    }

    fn render_task_detail(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut detail = v_flex()
            .w_full()
            .gap(px(11.))
            .child(
                div()
                    .text_size(px(17.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(task.title.clone()),
            )
            .child(muted(
                format!("{} · {}", task.owner.label(), task.state.label()),
                cx,
            ));
        if let Some(due) = &task.due {
            detail = detail.child(
                div()
                    .text_size(px(12.))
                    .text_color(style::needs_you_text(cx))
                    .child(format!(
                        "{} {}",
                        if task.state == State::Postponed {
                            "Postponed until"
                        } else {
                            "Due"
                        },
                        due_label(board, due)
                    )),
            );
        }
        if let Some(now) = &task.now {
            detail = detail.child(detail_field("Now", now, cx));
        }
        if let Some(done) = &task.done_when {
            detail = detail.child(detail_field("Done when", done, cx));
        }
        if let Some(answer) = task.decision.as_ref().and_then(|d| d.answer.as_ref()) {
            detail = detail.child(detail_field("Answer", answer, cx));
        }

        detail = detail.children(self.task_controls(coordinator, board, task, Surface::Tasks, cx));
        let mut subtasks = v_flex().gap(px(3.));
        let children = board
            .tasks
            .iter()
            .filter(|t| t.parent_task_id.as_deref() == Some(&task.id));
        let mut has_children = false;
        for child in children {
            has_children = true;
            subtasks = subtasks.child(self.task_list_row(
                &coordinator.project_id,
                board,
                child,
                None,
                false,
                cx,
            ));
        }
        if has_children {
            detail = detail.child(
                v_flex()
                    .gap(px(4.))
                    .child(muted("Sub-tasks", cx))
                    .child(subtasks),
            );
        }
        if let Some(source) = &task.source {
            let thread = source
                .thread_id
                .as_ref()
                .or_else(|| source.seq.is_some().then_some(&coordinator.thread_id));
            if let Some(thread) = thread {
                let coordinator_thread = coordinator.thread_id.clone();
                let thread = thread.clone();
                let seq = source.seq;
                let helper = self
                    .threads
                    .get(&coordinator_thread)
                    .and_then(|t| t.subagents.as_ref())
                    .is_some_and(|helpers| {
                        helpers.iter().any(|h| h["id"].as_str() == Some(&thread))
                    });
                let label = if helper || source.run_id.is_some() {
                    "Open helper thread"
                } else {
                    "Open source thread"
                };
                detail = detail.child(task_button("task-source", label, label).on_click(
                    cx.listener(move |this, _, window, cx| {
                        if thread == coordinator_thread {
                            this.jump_to_coordinator_loop(seq, window, cx);
                        } else if helper {
                            this.open_coordinator_tab(Tab::Activity, cx);
                            this.open_subagent(
                                coordinator_thread.clone(),
                                thread.clone(),
                                window,
                                cx,
                            );
                        } else {
                            this.open_thread_link(&thread, window, cx);
                        }
                    }),
                ));
            }
        }
        if let Some(at) = task.updated_at.as_deref().and_then(local_time) {
            detail = detail.child(muted(
                format!("Updated {}", at.format("%a %-d %b, %-I:%M %p")),
                cx,
            ));
        }
        detail.into_any_element()
    }

    pub(crate) fn render_task_highlights(
        &self,
        coordinator: &Coordinator,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Some(board) = coordinator.task_board.as_deref() else {
            return Empty.into_any_element();
        };
        let project = &coordinator.project_id;
        let ui = self.coordinators.task_boards.get(project);
        let undo = ui
            .and_then(|ui| ui.undo.as_deref())
            .and_then(|id| board.task(id))
            .filter(|task| task.state == State::Done && task.can_reopen);
        let mut contents = v_flex().w_full().gap(px(15.)).px(px(14.)).py(px(12.));
        let mut any = false;
        for (section, label, ink) in [
            (Highlight::NeedsYou, "Needs you", decision_blue(cx)),
            (Highlight::InFlight, "In flight", style::secondary_text(cx)),
            (
                Highlight::ReadyToClose,
                "Ready to close",
                style::added_text(cx),
            ),
        ] {
            let mut tasks = board
                .tasks
                .iter()
                .filter(|task| task.highlight() == Some(section))
                .peekable();
            let show_undo = section == Highlight::ReadyToClose && undo.is_some();
            if tasks.peek().is_none() && !show_undo {
                continue;
            }
            any = true;
            let mut list = v_flex()
                .w_full()
                .gap(px(6.))
                .child(section_label(label, ink));
            for task in tasks {
                let project = project.clone();
                let task_id = task.id.clone();
                let title = crate::highlights::tipped(
                    h_flex()
                        .id(id("highlight-task-title", &task.id))
                        .role(Role::Button)
                        .min_w_0()
                        .gap(px(6.))
                        .items_start()
                        .cursor_pointer()
                        .hover(|el| el.underline())
                        .child(mark_icon(task.mark(), cx))
                        .child(div().min_w_0().text_size(px(13.)).child(task.title.clone())),
                    format!("Open {} in Tasks", task.title),
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.select_board_task(&project, &task_id, cx);
                    this.open_coordinator_tab(Tab::Tasks, cx);
                }));
                let mut row = v_flex()
                    .id(id("highlight-task", &task.id))
                    .w_full()
                    .gap(px(6.))
                    .rounded(px(7.))
                    .when(section != Highlight::InFlight, |el| {
                        el.p(px(8.)).bg(ink.opacity(0.09))
                    })
                    .child(title);
                if let Some(due) = &task.due {
                    row = row.child(muted(due_label(board, due), cx));
                }
                if section != Highlight::InFlight {
                    row = row.children(task.now.as_ref().map(|now| muted(now.clone(), cx)));
                    row = row.children(self.task_controls(
                        coordinator,
                        board,
                        task,
                        Surface::Highlights,
                        cx,
                    ));
                }
                list = list.child(row);
            }
            if let Some(task) = undo.filter(|_| show_undo) {
                list = list.child(
                    v_flex()
                        .gap(px(5.))
                        .p(px(8.))
                        .rounded(px(7.))
                        .bg(style::added_line_bg(cx))
                        .child(muted(format!("Closed {}", task.title), cx))
                        .children(self.task_controls(
                            coordinator,
                            board,
                            task,
                            Surface::Highlights,
                            cx,
                        )),
                );
            }
            contents = contents.child(list);
        }
        if !any {
            contents = contents.child(muted("No open tasks", cx));
        }
        div()
            .id("coordinator-task-highlights")
            .w_full()
            .flex_none()
            .border_b_1()
            .border_color(style::hairline(cx))
            .child(contents)
            .into_any_element()
    }

    fn task_controls(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        surface: Surface,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let project = &coordinator.project_id;
        let ui = self.coordinators.task_boards.get(project);
        let pending = ui.is_some_and(|ui| ui.pending.contains(&Target::Task(task.id.clone())));
        if pending {
            return Some(
                h_flex()
                    .items_center()
                    .gap(px(6.))
                    .child(spinner(cx))
                    .child(muted("Updating task…", cx))
                    .into_any_element(),
            );
        }
        let main_action = match (&task.owner, task.kind, task.state) {
            (Owner::User, Kind::Action, state) if state != State::Done => {
                Some(("Done", "Mark this task done", TaskAction::Done))
            }
            (Owner::Agent, Kind::Action, State::ReadyToClose) => Some((
                "Got it, close",
                "Confirm this task is done",
                TaskAction::Close,
            )),
            (Owner::Agent, Kind::Action, State::Done) if task.can_reopen => {
                Some(("Undo", "Reopen this task", TaskAction::Reopen))
            }
            _ => None,
        };
        if let Some((label, tip, action)) = main_action {
            let button = task_button("task-main-action", label, tip);
            let button = match action {
                TaskAction::Close => button.success(),
                _ => button,
            };
            return Some(
                h_flex()
                    .child(self.wire_task_button(button, project, &task.id, action, cx))
                    .into_any_element(),
            );
        }

        if task.kind != Kind::Decision
            || task.owner != Owner::User
            || task.highlight() != Some(Highlight::NeedsYou)
        {
            return None;
        }

        Some(self.decision_controls(coordinator, board, task, surface, cx))
    }

    fn decision_controls(
        &self,
        coordinator: &Coordinator,
        board: &TaskBoard,
        task: &WorkTask,
        surface: Surface,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let project = &coordinator.project_id;
        let ui = self.coordinators.task_boards.get(project);
        let connected = self.connected();
        let ask = self
            .threads
            .get(&coordinator.thread_id)
            .and_then(|t| tasks::decision_ask(t, &task.id));
        let asks_seq = ask.map(|(_, seq)| seq);
        let editor = ui.and_then(|ui| ui.editor.as_ref()).filter(|editor| {
            editor.surface == surface && editor.task == task.id && editor.asks_seq == asks_seq
        });
        let mut controls = v_flex()
            .id(id("task-controls", &task.id))
            .w_full()
            .gap(px(7.));
        let ask = ask.map(|(ask, _)| ask);
        let text = if task.now.is_none() {
            ask.and_then(|a| a.why.as_deref())
        } else {
            None
        };
        if let Some(text) = text {
            controls = controls.child(detail_field("Now", text, cx));
        }
        if let Some(ask) = ask {
            controls = controls.children(self.decision_links(coordinator, ask, cx));
        }
        for (index, (label, note, suggested)) in decision_choices(task, ask).into_iter().enumerate()
        {
            // The conversation card's historical Not now choice is the
            // dedicated postpone control on both task surfaces.
            if label
                .trim()
                .trim_end_matches(['.', '!', '?'])
                .eq_ignore_ascii_case("not now")
            {
                continue;
            }
            let button = task_button(id("task-choice", &index.to_string()), label, label).when(
                suggested,
                |button| {
                    button
                        .primary()
                        .label(format!("{label} ★"))
                        .tooltip(format!("{label} (recommended)"))
                },
            );
            controls = controls.child(
                v_flex()
                    .gap(px(3.))
                    .items_start()
                    .child(self.wire_task_button(
                        button,
                        project,
                        &task.id,
                        TaskAction::Answer {
                            answer: label.to_owned(),
                            asks_seq,
                        },
                        cx,
                    ))
                    .children(note.map(|note| muted(note, cx))),
            );
        }
        let mode = editor.map(|editor| &editor.mode);
        let modes = h_flex()
            .flex_wrap()
            .gap(px(6.))
            .child(self.decision_mode_button(
                coordinator,
                task,
                asks_seq,
                surface,
                EditorChoice::Reply,
                matches!(mode, Some(EditMode::Reply { .. })),
                cx,
            ))
            .child(self.decision_mode_button(
                coordinator,
                task,
                asks_seq,
                surface,
                EditorChoice::Postpone,
                matches!(
                    mode,
                    Some(EditMode::Postpone | EditMode::AfterTask | EditMode::Date { .. })
                ),
                cx,
            ));
        controls = controls.child(modes);
        match mode {
            Some(EditMode::Reply { input, .. }) => {
                let reply = input.read(cx).value().trim().to_owned();
                controls = controls.child(
                    h_flex()
                        .gap(px(5.))
                        .w_full()
                        .child(
                            div()
                                .id("task-reply-input")
                                .min_w_0()
                                .flex_1()
                                .tip("Write your own reply")
                                .child(Input::new(input).small().disabled(!connected)),
                        )
                        .child(
                            self.wire_task_button(
                                task_button("send-task-reply", "Reply", "Send your own reply")
                                    .primary()
                                    .disabled(reply.is_empty()),
                                project,
                                &task.id,
                                TaskAction::Answer {
                                    answer: reply,
                                    asks_seq,
                                },
                                cx,
                            ),
                        ),
                );
            }
            Some(EditMode::Postpone | EditMode::Date { .. } | EditMode::AfterTask) => {
                let tomorrow = self.wire_task_button(
                    task_button(
                        "task-postpone-tomorrow",
                        "Tomorrow 9 a.m.",
                        "Postpone until tomorrow at 9 a.m.",
                    ),
                    project,
                    &task.id,
                    TaskAction::Postpone {
                        due: PostponeUntil::Tomorrow,
                        asks_seq,
                    },
                    cx,
                );
                let dependencies = board.dependencies(&task.id);
                controls = controls.child(
                    h_flex()
                        .flex_wrap()
                        .gap(px(6.))
                        .child(tomorrow)
                        .child(self.decision_mode_button(
                            coordinator,
                            task,
                            asks_seq,
                            surface,
                            EditorChoice::Date,
                            matches!(mode, Some(EditMode::Date { .. })),
                            cx,
                        ))
                        .when(!dependencies.is_empty(), |el| {
                            el.child(self.decision_mode_button(
                                coordinator,
                                task,
                                asks_seq,
                                surface,
                                EditorChoice::AfterTask,
                                matches!(mode, Some(EditMode::AfterTask)),
                                cx,
                            ))
                        }),
                );
                if let Some(EditMode::Date { picker, .. }) = mode {
                    controls = controls.child(
                        crate::highlights::tipped_as(
                            div().id("task-date-picker").w(px(165.)).max_w_full(),
                            "Choose a date at 9 a.m.",
                            Role::GenericContainer,
                        )
                        .child(DatePicker::new(picker).small().placeholder("Choose a date")),
                    );
                }
                if let Some(EditMode::AfterTask) = mode {
                    let rows = dependencies.into_iter().map(|dependency| {
                        let label = format!("After {}", dependency.title);
                        self.wire_task_button(
                            task_button(id("task-postpone-after", &dependency.id), &label, &label),
                            project,
                            &task.id,
                            TaskAction::Postpone {
                                due: PostponeUntil::AfterTask {
                                    task_id: dependency.id.clone(),
                                },
                                asks_seq,
                            },
                            cx,
                        )
                    });
                    controls = controls.child(v_flex().items_start().gap(px(4.)).children(rows));
                }
            }
            None => {}
        }
        controls.into_any_element()
    }

    fn decision_links(
        &self,
        coordinator: &Coordinator,
        ask: &OpenAsk,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let links = ask.links.as_ref()?;
        let links = links.iter().enumerate().filter_map(|(index, link)| {
            let label = link["title"].as_str()?;
            let url = link["url"].as_str()?;
            let url = if url.starts_with('/') {
                threadbear_core::open_policy::file_url(url)
            } else {
                url.to_owned()
            };
            let thread = coordinator.thread_id.clone();
            Some(
                task_button(id("task-decision-link", &index.to_string()), label, label).on_click(
                    cx.listener(move |this, _, window, cx| {
                        if let Some(pane) = this.pane_for(&thread, cx) {
                            // A link can read the app again to open a side pane.
                            let url = url.clone();
                            window.defer(cx, move |window, cx| {
                                pane.update(cx, |pane, cx| pane.link_clicked(&url, "", window, cx));
                            });
                        }
                    }),
                ),
            )
        });
        Some(
            h_flex()
                .flex_wrap()
                .gap(px(5.))
                .children(links)
                .into_any_element(),
        )
    }

    fn wire_task_button(
        &self,
        button: Button,
        project: &str,
        task: &str,
        action: TaskAction,
        cx: &mut Context<Self>,
    ) -> Button {
        let (project, task) = (project.to_owned(), task.to_owned());
        button
            .when(!self.connected(), |button| button.disabled(true))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.task_action(&project, &task, action.clone(), window, cx);
            }))
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "The control needs its surface and card revision to keep draft state scoped"
    )]
    fn decision_mode_button(
        &self,
        coordinator: &Coordinator,
        task: &WorkTask,
        asks_seq: Option<u64>,
        surface: Surface,
        choice: EditorChoice,
        active: bool,
        cx: &mut Context<Self>,
    ) -> Button {
        let (label, tip) = match choice {
            EditorChoice::Postpone => ("Not now", "Show postponement options"),
            EditorChoice::Date => ("Pick a date", "Postpone to a date"),
            EditorChoice::AfterTask => ("After a task", "Postpone until another task is done"),
            EditorChoice::Reply => ("Write my own", "Write your own reply"),
        };
        let project = coordinator.project_id.clone();
        let task = task.id.clone();
        task_button(id("decision-mode", label), label, tip)
            .selected(active)
            .on_click(cx.listener(move |this, _, window, cx| {
                let mode = if active {
                    match choice {
                        EditorChoice::Date | EditorChoice::AfterTask => {
                            Some(EditorChoice::Postpone)
                        }
                        _ => None,
                    }
                } else {
                    Some(choice)
                };
                this.edit_decision(
                    &project,
                    DecisionEditorTarget {
                        surface,
                        task: task.clone(),
                        asks_seq,
                    },
                    mode,
                    window,
                    cx,
                );
            }))
    }

    fn edit_decision(
        &mut self,
        project: &str,
        target: DecisionEditorTarget,
        choice: Option<EditorChoice>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (project, task, asks_seq) = (project.to_owned(), target.task.clone(), target.asks_seq);
        let editor = choice.map(|choice| {
            let mode = match choice {
                EditorChoice::Postpone => EditMode::Postpone,
                EditorChoice::AfterTask => EditMode::AfterTask,
                EditorChoice::Date => {
                    let picker = cx.new(|cx| {
                        DatePickerState::new(window, cx).disabled_matcher(|date: &NaiveDate| {
                            !tasks::can_postpone_to_date(*date, Local::now().naive_local())
                        })
                    });
                    let project = project.clone();
                    let change = cx.subscribe_in(
                        &picker,
                        window,
                        move |this, _, event: &DatePickerEvent, window, cx| {
                            let DatePickerEvent::Change(date) = event;
                            if let Some(chosen) = date.start() {
                                if !tasks::can_postpone_to_date(
                                    chosen.date(),
                                    Local::now().naive_local(),
                                ) {
                                    this.show_error(
                                        "Choose a postpone time in the future.".to_owned(),
                                        cx,
                                    );
                                    return;
                                }
                                let date = chosen.format("%Y-%m-%d").to_string();
                                this.task_action(
                                    &project,
                                    &task,
                                    TaskAction::Postpone {
                                        due: PostponeUntil::Date { date },
                                        asks_seq,
                                    },
                                    window,
                                    cx,
                                );
                            }
                        },
                    );
                    EditMode::Date {
                        picker,
                        _change: change,
                    }
                }
                EditorChoice::Reply => {
                    let input = cx.new(|cx| InputState::new(window, cx).placeholder("Your reply"));
                    window.focus(&input.read(cx).focus_handle(cx), cx);
                    crate::web_panels::keyboard_to_app(window);
                    let project = project.clone();
                    let enter = cx.subscribe_in(
                        &input,
                        window,
                        move |this, input, event: &InputEvent, window, cx| {
                            if matches!(event, InputEvent::Change) {
                                cx.notify();
                            }
                            if matches!(event, InputEvent::PressEnter { .. }) {
                                let answer = input.read(cx).value().trim().to_owned();
                                if !answer.is_empty() {
                                    this.task_action(
                                        &project,
                                        &task,
                                        TaskAction::Answer { answer, asks_seq },
                                        window,
                                        cx,
                                    );
                                }
                            }
                        },
                    );
                    EditMode::Reply {
                        input,
                        _enter: enter,
                    }
                }
            };
            DecisionEditor {
                surface: target.surface,
                task: target.task,
                asks_seq,
                mode,
            }
        });
        self.coordinators
            .task_boards
            .entry(project)
            .or_default()
            .editor = editor;
        cx.notify();
    }
}

#[derive(Clone, Copy)]
enum EditorChoice {
    Postpone,
    Date,
    AfterTask,
    Reply,
}

struct DecisionEditorTarget {
    surface: Surface,
    task: String,
    asks_seq: Option<u64>,
}

fn decision_choices<'a>(
    task: &'a WorkTask,
    ask: Option<&'a OpenAsk>,
) -> Vec<(&'a str, Option<&'a str>, bool)> {
    let decision = task.decision.as_ref();
    let recommended = decision.and_then(|d| d.recommendation.as_deref());
    if let Some((ask, options)) = ask
        .and_then(|ask| Some((ask, ask.options.as_ref()?)))
        .filter(|(_, options)| !options.is_empty())
    {
        return options
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let note = ask
                    .option_notes
                    .as_ref()
                    .filter(|notes| notes.len() == options.len())
                    .and_then(|notes| notes.get(index))
                    .map(String::as_str)
                    .filter(|note| !note.is_empty())
                    .or_else(|| {
                        decision?
                            .options
                            .iter()
                            .find(|option| option.label == *label)?
                            .does
                            .as_deref()
                    });
                let suggested = ask
                    .suggested
                    .map_or(recommended == Some(label), |selected| index == selected);
                (label.as_str(), note, suggested)
            })
            .collect();
    }
    decision
        .into_iter()
        .flat_map(|d| &d.options)
        .map(|option| {
            (
                option.label.as_str(),
                option.does.as_deref(),
                recommended == Some(&option.label),
            )
        })
        .collect()
}

fn id(prefix: &str, key: &str) -> ElementId {
    SharedString::from(format!("{prefix}-{key}")).into()
}

fn task_button(id: impl Into<ElementId>, label: &str, tip: &str) -> Button {
    Button::new(id)
        .label(label.to_owned())
        .small()
        .tooltip(tip.to_owned())
}

fn spinner(cx: &App) -> AnyElement {
    Spinner::new()
        .with_size(px(12.))
        .color(style::secondary_text(cx))
        .into_any_element()
}

fn muted(text: impl Into<SharedString>, cx: &App) -> Div {
    div()
        .text_size(px(12.))
        .line_height(px(17.))
        .text_color(style::secondary_text(cx))
        .child(text.into())
}

fn section_label(text: &str, ink: Hsla) -> Div {
    div()
        .text_size(px(12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(ink)
        .child(text.to_owned())
}

fn detail_field(label: &str, text: &str, cx: &App) -> Div {
    v_flex()
        .gap(px(2.))
        .child(muted(label.to_owned(), cx))
        .child(
            div()
                .text_size(px(13.))
                .line_height(px(18.))
                .child(text.to_owned()),
        )
}

fn decision_blue(cx: &App) -> Hsla {
    if cx.theme().mode.is_dark() {
        rgb(0x7aa7ff).into()
    } else {
        rgb(0x1d56ad).into()
    }
}

fn mark_icon(mark: Mark, cx: &App) -> Div {
    let ink = match mark {
        Mark::Decision if cx.theme().mode.is_dark() => rgb(0x3b82f6).into(),
        Mark::Decision => decision_blue(cx),
        _ => style::secondary_text(cx),
    };
    div()
        .flex_none()
        .w(px(14.))
        .text_size(px(13.))
        .text_center()
        .text_color(ink)
        .child(mark.glyph())
}

fn local_time(at: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.with_timezone(&Local))
}

fn short_due(due: &TaskDue) -> String {
    match due {
        TaskDue::At { at } => local_time(at)
            .map(|at| at.format("%a %-d").to_string())
            .unwrap_or_default(),
        TaskDue::AfterTask { .. } => "After task".to_owned(),
    }
}

fn due_label(board: &TaskBoard, due: &TaskDue) -> String {
    match due {
        TaskDue::At { at } => local_time(at)
            .map(|at| at.format("%a %-d %b, %-I:%M %p").to_string())
            .unwrap_or_else(|| at.clone()),
        TaskDue::AfterTask { task_id } => format!(
            "after {}",
            board
                .task(task_id)
                .map_or(task_id.as_str(), |task| task.title.as_str())
        ),
    }
}
