// The shared state behind a dock and its torn-out windows: the pure controller
// (threadbear-dock-layout) plus the change callback. One entity per dock, so
// every window of it redraws when any of them changes something.
use gpui_kit::*;
use threadbear_dock_layout::*;

pub struct DockModel {
    pub controller: DockController,
    /// Called when the layout changes, to save it.
    on_change: Option<Box<dyn FnMut(&DockLayout, &mut App)>>,
}

impl DockModel {
    pub fn new(layout: DockLayout) -> Self {
        Self {
            controller: DockController::new(layout),
            on_change: None,
        }
    }

    /// Called whenever the layout changes (a drag, a divider, a close...),
    /// to save it.
    pub fn on_change(&mut self, f: impl FnMut(&DockLayout, &mut App) + 'static) {
        self.on_change = Some(Box::new(f));
    }

    pub fn layout(&self) -> &DockLayout {
        &self.controller.layout
    }

    /// Runs a change to the controller, telling the app if the layout moved.
    pub fn update_controller<R>(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut DockController) -> R,
    ) -> R {
        let before = self.controller.layout.clone();
        let out = f(&mut self.controller);
        if self.controller.layout != before {
            if let Some(cb) = &mut self.on_change {
                cb(&self.controller.layout, cx);
            }
        }
        cx.notify();
        out
    }

    // The controller's commands, as an app calls them.

    pub fn close(&mut self, panel: &str, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.close(panel));
    }

    pub fn rename(&mut self, from: &str, to: &str, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.rename(from, to));
    }

    pub fn select(&mut self, panel: &str, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.select(panel));
    }

    pub fn set_title_hidden(&mut self, panel: &str, hidden: bool, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.set_title_hidden(panel, hidden));
    }

    pub fn show(&mut self, panel: &str, near: &[&str], fallback: DockDrop, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.show(panel, near, &fallback));
    }

    pub fn toggle(
        &mut self,
        panel: &str,
        near: &[&str],
        fallback: DockDrop,
        cx: &mut Context<Self>,
    ) {
        self.update_controller(cx, |c| c.toggle(panel, near, &fallback));
    }

    pub fn open(&mut self, panel: &str, drop: DockDrop, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.open(panel, drop));
    }

    pub fn set_layout(&mut self, layout: DockLayout, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.set_layout(layout));
    }

    /// Makes the group `panel` is in at least `width` points wide, for
    /// content that needs the room, taking it from what's beside the group
    /// down to `keep` points each (`DockController::widen`). Saved as a
    /// divider drag is, and it glides there as any change from code does.
    /// `available` is the content's answer for each panel, as the view draws
    /// by; `DockView::widen_panel` asks the content itself. Returns what it
    /// changed, for `restore_width`. None if nothing changed, or before the
    /// dock has been laid out.
    pub fn widen_panel(
        &mut self,
        panel: &str,
        width: f32,
        keep: f32,
        available: &dyn Fn(&str) -> bool,
        cx: &mut Context<Self>,
    ) -> Option<Widened> {
        self.update_controller(cx, |c| {
            c.widen(
                panel,
                width as f64,
                keep as f64,
                available,
                crate::theme::GAP as f64,
            )
        })
    }

    /// Puts back what `widen_panel` changed, and says whether it did: not
    /// once a divider there has been dragged, as that size was chosen since.
    pub fn restore_width(&mut self, widened: &Widened, cx: &mut Context<Self>) -> bool {
        self.update_controller(cx, |c| c.restore_width(widened))
    }

    pub fn put_back(&mut self, panel: &str, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.put_back(panel));
    }

    pub fn open_in_window(&mut self, panel: &str, cx: &mut Context<Self>) {
        self.update_controller(cx, |c| c.open_in_window(panel));
    }

    pub fn open_in_new_window(
        &mut self,
        panel: &str,
        size: threadbear_dock_layout::Size,
        cx: &mut Context<Self>,
    ) {
        self.update_controller(cx, |c| c.open_in_new_window(panel, size));
    }
}
