// Reordering the Threads sidebar's sections by dragging their headings:
// the default order (Starred above Coordinators), normalising a saved order,
// moving one section among the visible ones while keeping hidden ones in
// place, and tracking which compact slot the pointer targets during a drag
// without a jump when tall sections above fold shut on pickup.
// The GPUI view and pointer handling live in desktop/gpui/src/section_drag.rs.
use crate::inbox::Section;

/// Default sidebar section order: Starred stays at the very top, above
/// Coordinators, then Inbox, Running, Hibernating and Archived.
pub const DEFAULT_SECTION_ORDER: [&str; 6] = [
    "starred",
    "coordinators",
    "inbox",
    "running",
    "hibernating",
    "archived",
];

/// Pointer movement (in points) before a press on a heading becomes a drag
/// instead of a click to fold or unfold.
pub const DRAG_THRESHOLD: f32 = 5.;

/// Downward movement (in points) past the pickup point that engages a drag
/// started below its compact slot after tall sections above fold shut.
pub const DOWNWARD_ENGAGE: f32 = 16.;

/// Canonical section key for a stored key string.
pub fn section_key(raw: &str) -> Option<&'static str> {
    DEFAULT_SECTION_ORDER.into_iter().find(|key| *key == raw)
}

/// Canonical section key for either a key ("inbox") or display title ("Inbox").
pub fn section_key_by_name(name: &str) -> Option<&'static str> {
    let lower = name.trim().to_lowercase();
    DEFAULT_SECTION_ORDER.into_iter().find(|key| *key == lower)
}

/// Normalises a saved section order: keeps each known key once in its saved
/// order, ignores unknown keys, and appends any missing defaults at the end
/// in their default order.
pub fn normalize_section_order(saved: Option<&[String]>) -> Vec<&'static str> {
    let mut out = Vec::with_capacity(DEFAULT_SECTION_ORDER.len());
    if let Some(saved) = saved {
        for raw in saved {
            if let Some(key) = section_key(raw) {
                if !out.contains(&key) {
                    out.push(key);
                }
            }
        }
    }
    for key in DEFAULT_SECTION_ORDER {
        if !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// Whether `order` matches `DEFAULT_SECTION_ORDER`.
pub fn is_default_section_order(order: &[&str]) -> bool {
    order == DEFAULT_SECTION_ORDER
}

/// Orders `sections` according to `order`. Any section not named in `order`
/// keeps its relative order at the end.
pub fn reorder_sections<T>(mut sections: Vec<Section<T>>, order: &[&str]) -> Vec<Section<T>> {
    let rank = |key: &str| order.iter().position(|k| *k == key).unwrap_or(order.len());
    sections.sort_by_key(|s| rank(s.key));
    sections
}

/// Moves `key` so that among `visible` sections it lands at `to_visible_index`,
/// leaving hidden (empty) sections in their neighbourhood in `full_order`.
pub fn move_section(
    full_order: &[&'static str],
    key: &'static str,
    visible: &[&'static str],
    to_visible_index: usize,
) -> Vec<&'static str> {
    let Some(old_visible) = visible.iter().position(|k| *k == key) else {
        return full_order.to_vec();
    };
    let clamped = to_visible_index.min(visible.len().saturating_sub(1));
    if clamped == old_visible {
        return full_order.to_vec();
    }
    let mut rest: Vec<&'static str> = full_order.iter().copied().filter(|k| *k != key).collect();
    let rest_visible: Vec<&'static str> = visible.iter().copied().filter(|k| *k != key).collect();
    if clamped < rest_visible.len() {
        let anchor = rest_visible[clamped];
        let at = rest.iter().position(|k| *k == anchor).unwrap_or(rest.len());
        rest.insert(at, key);
    } else if let Some(&prev) = rest_visible.last() {
        let at = rest
            .iter()
            .position(|k| *k == prev)
            .map_or(rest.len(), |i| i + 1);
        rest.insert(at, key);
    } else {
        rest.push(key);
    }
    rest
}

/// Tracks which compact slot a dragged section heading targets while open
/// sections are temporarily folded shut on pickup.
///
/// When tall sections above the dragged heading collapse, the heading's compact
/// slot moves up above the pointer's pickup Y. Holding `engaged = false` until
/// the pointer reaches the compact stack (or its own compact slot) or drags
/// deliberately downward prevents the section from jumping to the bottom on
/// pickup while keeping 1:1 visual alignment once engaged.
#[derive(Clone, Debug, PartialEq)]
pub struct SlotTracker {
    dragged: &'static str,
    visible: Vec<&'static str>,
    orig_index: usize,
    target_index: usize,
    start_y: f32,
    engaged: bool,
}

impl SlotTracker {
    pub fn new(
        dragged: &'static str,
        visible: Vec<&'static str>,
        start_y: f32,
        stack_top: f32,
        slot_height: f32,
    ) -> Self {
        let orig_index = visible.iter().position(|k| *k == dragged).unwrap_or(0);
        let own_bottom = stack_top + (orig_index as f32 + 1.) * slot_height;
        let engaged = slot_height > 0. && start_y <= own_bottom;
        Self {
            dragged,
            visible,
            orig_index,
            target_index: orig_index,
            start_y,
            engaged,
        }
    }

    pub fn dragged(&self) -> &'static str {
        self.dragged
    }

    pub fn visible(&self) -> &[&'static str] {
        &self.visible
    }

    pub fn orig_index(&self) -> usize {
        self.orig_index
    }

    pub fn target_index(&self) -> usize {
        self.target_index
    }

    /// Updates `target_index` for `probe_y` (the floating heading pill's
    /// vertical centre). Returns `true` when `target_index` changed.
    pub fn move_to(&mut self, probe_y: f32, stack_top: f32, slot_height: f32) -> bool {
        let n = self.visible.len();
        if n <= 1 || slot_height <= 1. {
            return false;
        }
        if !self.engaged {
            let stack_bottom = stack_top + n as f32 * slot_height;
            let own_bottom = stack_top + (self.orig_index as f32 + 1.) * slot_height;
            let enter_threshold = if self.start_y > stack_bottom {
                stack_bottom
            } else {
                own_bottom
            };
            if probe_y <= enter_threshold || probe_y >= self.start_y + DOWNWARD_ENGAGE {
                self.engaged = true;
            } else {
                return false;
            }
        }
        let rel = (probe_y - stack_top) / slot_height;
        let next = (rel.floor() as isize).clamp(0, (n - 1) as isize) as usize;
        let changed = next != self.target_index;
        self.target_index = next;
        changed
    }

    /// Full section order with `dragged` placed at `target_index`.
    pub fn preview_order(&self, full_order: &[&'static str]) -> Vec<&'static str> {
        move_section(full_order, self.dragged, &self.visible, self.target_index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(list: &[&str]) -> Vec<String> {
        list.iter().map(|k| (*k).to_owned()).collect()
    }

    #[test]
    fn default_order_puts_starred_above_coordinators() {
        assert_eq!(
            DEFAULT_SECTION_ORDER,
            [
                "starred",
                "coordinators",
                "inbox",
                "running",
                "hibernating",
                "archived",
            ]
        );
        assert_eq!(normalize_section_order(None), DEFAULT_SECTION_ORDER);
        assert!(is_default_section_order(&DEFAULT_SECTION_ORDER));
    }

    #[test]
    fn normalize_keeps_valid_order_drops_unknowns_and_appends_missing() {
        let saved = s(&["running", "unknown", "inbox", "running", "starred"]);
        assert_eq!(
            normalize_section_order(Some(&saved)),
            vec![
                "running",
                "inbox",
                "starred",
                "coordinators",
                "hibernating",
                "archived",
            ]
        );
    }

    #[test]
    fn move_section_reorders_visible_and_preserves_hidden_neighbours() {
        let full = DEFAULT_SECTION_ORDER.to_vec();
        // Starred is hidden; drag Running above Inbox (visible index 1).
        let visible = vec![
            "coordinators",
            "inbox",
            "running",
            "hibernating",
            "archived",
        ];
        assert_eq!(
            move_section(&full, "running", &visible, 1),
            vec![
                "starred",
                "coordinators",
                "running",
                "inbox",
                "hibernating",
                "archived",
            ]
        );
        // Hibernating & Archived hidden; drag Starred to the end of visible.
        let visible = vec!["starred", "inbox", "running"];
        assert_eq!(
            move_section(&full, "starred", &visible, 2),
            vec![
                "coordinators",
                "inbox",
                "running",
                "starred",
                "hibernating",
                "archived",
            ]
        );
        // Same index is a no-op.
        assert_eq!(move_section(&full, "inbox", &visible, 1), full);
    }

    #[test]
    fn slot_tracker_avoids_jump_when_tall_sections_above_collapse() {
        let visible = vec![
            "starred",
            "coordinators",
            "inbox",
            "running",
            "hibernating",
            "archived",
        ];
        // Compact slots: 40pt tall starting at y=50 -> 50..290.
        // Running (index 3) was picked up way down at y=420 because Inbox was tall.
        let mut tracker = SlotTracker::new("running", visible, 420., 50., 40.);
        assert_eq!(tracker.target_index(), 3);
        // Hovering near pickup or sliding partway up toward the stack doesn't jump to Archived.
        assert!(!tracker.move_to(410., 50., 40.));
        assert_eq!(tracker.target_index(), 3);
        assert!(!tracker.move_to(320., 50., 40.));
        assert_eq!(tracker.target_index(), 3);
        // Entering the compact stack over Inbox (slot 2: 130..170) moves cleanly to index 2.
        assert!(tracker.move_to(150., 50., 40.));
        assert_eq!(tracker.target_index(), 2);
        // Dragging above Starred clamps to index 0.
        assert!(tracker.move_to(20., 50., 40.));
        assert_eq!(tracker.target_index(), 0);
    }

    #[test]
    fn slot_tracker_handles_short_collapse_and_downward_drag() {
        let visible = vec![
            "starred",
            "coordinators",
            "inbox",
            "running",
            "hibernating",
            "archived",
        ];
        // Compact slots: 40pt tall starting at y=50 (Coordinators slot 1 is 90..130).
        // Starred had 1 row (48pt), so Coordinators was picked up at y=150 (over Inbox's compact slot).
        let mut tracker = SlotTracker::new("coordinators", visible.clone(), 150., 50., 40.);
        assert_eq!(tracker.target_index(), 1);
        // Small movement at pickup doesn't jump Coordinators below Inbox.
        assert!(!tracker.move_to(148., 50., 40.));
        assert_eq!(tracker.target_index(), 1);
        // Dragging up into Coordinators' own compact slot engages without jumping, then up to Starred swaps to 0.
        assert!(!tracker.move_to(110., 50., 40.));
        assert_eq!(tracker.target_index(), 1);
        assert!(tracker.move_to(70., 50., 40.));
        assert_eq!(tracker.target_index(), 0);

        // Starting again at y=150, dragging deliberately downward engages and moves below Inbox.
        let mut down = SlotTracker::new("coordinators", visible, 150., 50., 40.);
        assert!(down.move_to(170., 50., 40.));
        assert_eq!(down.target_index(), 3);
    }

    #[test]
    fn slot_tracker_engages_immediately_for_top_section() {
        let visible = vec!["starred", "coordinators", "inbox"];
        let mut tracker = SlotTracker::new("starred", visible, 68., 50., 40.);
        assert_eq!(tracker.target_index(), 0);
        assert!(tracker.move_to(105., 50., 40.));
        assert_eq!(tracker.target_index(), 1);
        assert!(tracker.move_to(200., 50., 40.));
        assert_eq!(tracker.target_index(), 2);
    }

    #[test]
    fn reorder_sections_orders_by_custom_keys() {
        let sections = vec![
            Section {
                key: "starred",
                title: "Starred",
                rows: vec![1],
            },
            Section {
                key: "inbox",
                title: "Inbox",
                rows: vec![2],
            },
            Section {
                key: "running",
                title: "Running",
                rows: vec![3],
            },
        ];
        let reordered = reorder_sections(sections, &["running", "starred", "inbox"]);
        let keys: Vec<&str> = reordered.iter().map(|s| s.key).collect();
        assert_eq!(keys, ["running", "starred", "inbox"]);
    }
}
