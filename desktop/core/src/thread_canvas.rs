//! The Canvas page (the `threadCanvas` experiment): every live thread as a
//! miniature of its window on one board you zoom round, each of Mike's
//! projects an area of its own, trees of threads growing left to right with
//! an arrow from each thread to the ones it started. This is where things sit
//! and how that changes; the app draws it (desktop/gpui/src/thread_canvas.rs).
//!
//! Mike, 24 Nov 2026, from prototypes (~/dev/me/misc/thread-canvas: `zoom`
//! for the interaction, `live/a-islands` for the layout): "Let's try this way
//! first, see how it goes." The rules he picked, in the islands notes:
//!
//! - Areas have fixed places, set once, biggest first: the biggest anchored
//!   on the left, the rest packed beside it. They never reshuffle.
//! - A new thread arrives beside its parent (the cell to its right, or the
//!   nearest free one right or just below), or at its area's open edge, and
//!   nothing else moves.
//! - An archived thread becomes a faint ghost pill in place that keeps its
//!   arrows. Ghosts go only once their whole tree is archived (after a
//!   grace), and the hole is reused by the next arrival. Only Tidy reflows.
//! - Threads a schedule, a tool or the runner started with no parent stay
//!   off the board in a strip, and move onto their area only once they're
//!   waiting on Mike.
//!
//! Everything is in world units, where a thread's window is 720 wide; the
//! camera (review_canvas's) maps them to the screen.

use crate::inbox::{parse_ms, ThreadSummary};
pub use crate::review_canvas::{ease, Camera, Rect};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

/// The experiment's id in runner.json and hello's list.
pub const EXPERIMENT: &str = "threadCanvas";
/// The area of threads in no project.
pub const LOOSE: &str = "loose";

/// A thread's window on the board.
pub const WIN_W: f32 = 720.;
pub const WIN_H: f32 = 860.;
/// Its title bar.
pub const HEADER_H: f32 = 46.;
/// An archived thread's pill.
pub const GHOST_H: f32 = 58.;
/// Room between windows: across, for the arrows and their words.
pub const GAP_X: f32 = 420.;
pub const GAP_Y: f32 = 110.;
pub const CELL_W: f32 = WIN_W + GAP_X;
pub const CELL_H: f32 = WIN_H + GAP_Y;
/// An area's margin round its windows, and the room between areas.
pub const AREA_PAD: f32 = 150.;
pub const AREA_GAP: f32 = 420.;
/// Columns per band: a root and room for its children to its right.
pub const BAND: u32 = 2;
/// How long a wholly archived tree's ghosts stay before they clear.
pub const GHOST_GRACE_MS: i64 = 90 * 60 * 1000;
/// Who starts the threads that wait in the strip: anything but Mike or a thread.
const AUTOMATED: [&str; 4] = ["schedule", "tool", "runner", "librarian"];

/// One live thread, as the board needs it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Entry {
    pub id: String,
    pub title: String,
    /// Its project's id, or LOOSE.
    pub area: String,
    pub area_title: String,
    /// The thread that started it, when that one's on this runner.
    pub parent: Option<String>,
    /// Why its starter started it (`startedBy.why`), for the arrow.
    pub why: Option<String>,
    /// Started by a schedule, a tool or the runner, with no parent here.
    pub automated: bool,
    /// Waiting on Mike (the amber dot).
    pub waiting: bool,
    pub created_ms: i64,
}

/// The live (not archived) threads as entries. A thread in no project takes
/// its parent's (as far up as six), else it's Loose.
pub fn entries<'a>(threads: impl IntoIterator<Item = &'a ThreadSummary>) -> Vec<Entry> {
    let live: Vec<&ThreadSummary> = threads
        .into_iter()
        .filter(|t| !t.is_archived() && t.sample != Some(true))
        .collect();
    let by_id: HashMap<&str, &ThreadSummary> = live.iter().map(|t| (t.id.as_str(), *t)).collect();
    let parent_of = |t: &ThreadSummary| -> Option<String> {
        let s = t.started_by.as_ref()?;
        (s["kind"] == "thread")
            .then(|| s["threadId"].as_str().map(str::to_owned))
            .flatten()
    };
    let project_of = |t: &ThreadSummary| {
        t.projects
            .as_ref()
            .and_then(|p| p.first())
            .map(|p| (p.id.clone(), p.title.clone()))
    };
    let mut out: Vec<Entry> = live
        .iter()
        .map(|t| {
            let mut area = project_of(t);
            let mut up = parent_of(t);
            let mut depth = 0;
            while area.is_none() && depth < 6 {
                let Some(p) = up.as_deref().and_then(|id| by_id.get(id)) else {
                    break;
                };
                area = project_of(p);
                up = parent_of(p);
                depth += 1;
            }
            let (area, area_title) = area.unwrap_or_else(|| (LOOSE.into(), "Loose".into()));
            let parent = parent_of(t).filter(|p| by_id.contains_key(p.as_str()));
            let kind = t
                .started_by
                .as_ref()
                .and_then(|s| s["kind"].as_str())
                .unwrap_or("");
            Entry {
                id: t.id.clone(),
                title: t.title.clone(),
                area,
                area_title,
                why: t
                    .started_by
                    .as_ref()
                    .and_then(|s| s["why"].as_str())
                    .filter(|w| !w.trim().is_empty())
                    .map(str::to_owned),
                automated: AUTOMATED.contains(&kind) && parent.is_none(),
                parent,
                waiting: t.wants_you(),
                created_ms: t
                    .created_at
                    .as_deref()
                    .and_then(parse_ms)
                    .unwrap_or_else(|| t.activity_ms()),
            }
        })
        .collect();
    out.sort_by(|a, b| a.created_ms.cmp(&b.created_ms).then(a.id.cmp(&b.id)));
    out
}

/// A project's area: its fixed place and the room kept for it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Area {
    pub title: String,
    pub x: f32,
    pub y: f32,
    /// The room it was given when it was placed, which later areas keep out of.
    pub w: f32,
    pub h: f32,
    /// How many bands of BAND columns its threads fill across.
    pub bands: u32,
}

impl Area {
    fn cols(&self) -> u32 {
        self.bands.max(1) * BAND
    }

    fn room(&self) -> Rect {
        Rect::new(self.x, self.y, self.w, self.h)
    }
}

/// An archived thread's pill, kept until its whole tree has gone.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Ghost {
    pub since_ms: i64,
    /// Set once every thread in its tree is archived.
    pub clear_at_ms: Option<i64>,
}

/// Where a thread sits: a cell of its area's grid, or where Mike dragged it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Spot {
    pub area: String,
    pub col: u32,
    pub row: u32,
    /// Moved by hand: its window's top left on the board.
    pub at: Option<(f32, f32)>,
    pub title: String,
    pub parent: Option<String>,
    pub why: Option<String>,
    pub ghost: Option<Ghost>,
}

/// What a sync changed, for the app's arrivals and collapses.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changes {
    pub arrived: Vec<String>,
    pub archived: Vec<String>,
    /// Areas something arrived in, to glow.
    pub glow: Vec<String>,
}

/// The whole board as it's kept between launches.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Layout {
    pub areas: BTreeMap<String, Area>,
    pub spots: BTreeMap<String, Spot>,
    /// The camera when last looked at: scale, then offset.
    pub camera: Option<[f32; 3]>,
}

/// An arrow from a thread to one it started.
#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub parent: String,
    pub child: String,
    /// Its place among its siblings, centred on 0, so they fan out.
    pub k: f32,
}

/// An arrow's curve on the board: start, two controls, end, and where its
/// words go.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Curve {
    pub start: (f32, f32),
    pub c1: (f32, f32),
    pub c2: (f32, f32),
    pub end: (f32, f32),
    pub mid: (f32, f32),
}

impl Layout {
    pub fn from_json(v: &serde_json::Value) -> Layout {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    /// Brings the board up to date with the live threads and the projects
    /// (id, title, archived; for their names). New areas get a place clear of the others,
    /// new threads a cell, archived ones become ghosts, and ghosts whose
    /// whole tree is archived clear after the grace. Nothing else moves.
    pub fn sync(
        &mut self,
        entries: &[Entry],
        projects: &[(String, String, bool)],
        now_ms: i64,
    ) -> Changes {
        let mut changes = Changes::default();
        let live: HashMap<&str, &Entry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
        // Gone from the live list: a ghost in place. Back again: itself.
        // Moved to another project: it arrives there afresh.
        let mut moved = Vec::new();
        for (id, spot) in &mut self.spots {
            match live.get(id.as_str()) {
                None if spot.ghost.is_none() => {
                    spot.ghost = Some(Ghost {
                        since_ms: now_ms,
                        clear_at_ms: None,
                    });
                    changes.archived.push(id.clone());
                }
                None => {}
                Some(e) if e.area != spot.area => moved.push(id.clone()),
                Some(e) => {
                    spot.ghost = None;
                    spot.title.clone_from(&e.title);
                    spot.why.clone_from(&e.why);
                }
            }
        }
        for id in moved {
            self.spots.remove(&id);
        }
        self.settle_ghosts(now_ms);

        // Areas: one for each project a thread on the board is in, made the
        // first time it has one and kept from then on (faint while empty).
        // A project with nothing live gets none: Mike has about ninety, and
        // a board of empty ones buried the busy ones (24 Nov, on his data).
        let on_board = |e: &Entry| !e.automated || e.waiting;
        let mut wanted: Vec<(String, String)> = Vec::new();
        for e in entries.iter().filter(|e| on_board(e)) {
            if !wanted.iter().any(|(id, _)| *id == e.area) {
                let title = projects
                    .iter()
                    .find(|(id, ..)| *id == e.area)
                    .map_or_else(|| e.area_title.clone(), |(_, t, _)| t.clone());
                wanted.push((e.area.clone(), title));
            }
        }
        for (id, title, _) in projects {
            if let Some(a) = self.areas.get_mut(id) {
                a.title.clone_from(title);
            }
        }
        let first = self.areas.is_empty();
        let mut new_areas: Vec<(String, String, usize)> = Vec::new();
        for (id, title) in &wanted {
            match self.areas.get_mut(id) {
                Some(a) => a.title.clone_from(title),
                None => {
                    let n = entries
                        .iter()
                        .filter(|e| e.area == *id && on_board(e) && !self.spots.contains_key(&e.id))
                        .count();
                    new_areas.push((id.clone(), title.clone(), n));
                }
            }
        }
        // Biggest first, then by name; placed once.
        new_areas.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
        for (id, title, n) in &new_areas {
            self.areas.insert(
                id.clone(),
                Area {
                    title: title.clone(),
                    bands: bands_for(*n),
                    ..Area::default()
                },
            );
        }

        // New threads, oldest first, and a parent always before its child
        // (a parent's creation time can be missing, and its activity later).
        let pending: HashMap<&str, &Entry> = entries
            .iter()
            .filter(|e| !self.spots.contains_key(&e.id) && on_board(e))
            .map(|e| (e.id.as_str(), e))
            .collect();
        for e in entries {
            let mut chain = vec![e];
            let mut up = e.parent.as_deref();
            while let Some(p) = up.and_then(|p| pending.get(p)) {
                if chain.iter().any(|c| c.id == p.id) {
                    break;
                }
                chain.push(p);
                up = p.parent.as_deref();
            }
            for e in chain.into_iter().rev() {
                if self.spots.contains_key(&e.id) || !on_board(e) {
                    continue;
                }
                self.place(e, false);
                changes.arrived.push(e.id.clone());
                if !changes.glow.contains(&e.area) {
                    changes.glow.push(e.area.clone());
                }
            }
        }

        // The new areas' places, now their first threads say how big they are.
        let order: Vec<String> = new_areas.into_iter().map(|(id, ..)| id).collect();
        for (i, id) in order.iter().enumerate() {
            let (cols, rows) = self.used(id);
            let extra = if first && i == 0 { 2 } else { 1 };
            if let Some(a) = self.areas.get_mut(id) {
                a.w = cols.max(1) as f32 * CELL_W - GAP_X + AREA_PAD * 2.;
                a.h = (rows.max(1) + extra) as f32 * CELL_H - GAP_Y + AREA_PAD * 2.;
            }
        }
        if first {
            self.pack(&order);
        } else {
            for id in &order {
                self.find_room(id);
            }
        }
        if first {
            // The first look isn't an arrival.
            changes = Changes::default();
        }
        changes
    }

    /// Threads in the strip: started by a schedule, a tool or the runner,
    /// not on the board, newest first.
    pub fn strip<'a>(&self, entries: &'a [Entry]) -> Vec<&'a Entry> {
        let mut out: Vec<&Entry> = entries
            .iter()
            .filter(|e| e.automated && !self.spots.contains_key(&e.id))
            .collect();
        out.reverse();
        out
    }

    /// Clears ghosts whose tree has been wholly archived for the grace, and
    /// starts the grace on ones that just became so.
    fn settle_ghosts(&mut self, now_ms: i64) {
        let ghosts: Vec<String> = self
            .spots
            .iter()
            .filter(|(_, s)| s.ghost.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        let mut seen = HashSet::new();
        for id in ghosts {
            if seen.contains(&id) {
                continue;
            }
            let tree = self.tree(&id);
            seen.extend(tree.iter().cloned());
            let all = tree
                .iter()
                .all(|t| self.spots.get(t).is_some_and(|s| s.ghost.is_some()));
            for t in &tree {
                if let Some(g) = self.spots.get_mut(t).and_then(|s| s.ghost.as_mut()) {
                    g.clear_at_ms = if all {
                        Some(g.clear_at_ms.unwrap_or(now_ms + GHOST_GRACE_MS))
                    } else {
                        None
                    };
                }
            }
        }
        self.spots.retain(|_, s| {
            !s.ghost
                .as_ref()
                .is_some_and(|g| g.clear_at_ms.is_some_and(|t| t <= now_ms))
        });
    }

    /// The threads joined to `id` by parent links, in its area.
    fn tree(&self, id: &str) -> Vec<String> {
        let Some(area) = self.spots.get(id).map(|s| s.area.clone()) else {
            return vec![];
        };
        let mut out = vec![id.to_owned()];
        let mut i = 0;
        while i < out.len() {
            let x = out[i].clone();
            let up = self.spots.get(&x).and_then(|s| s.parent.clone());
            for (y, s) in &self.spots {
                if s.area != area || out.contains(y) {
                    continue;
                }
                if s.parent.as_deref() == Some(x.as_str()) || up.as_deref() == Some(y.as_str()) {
                    out.push(y.clone());
                }
            }
            i += 1;
        }
        out
    }

    fn taken(&self, area: &str) -> HashSet<(u32, u32)> {
        self.spots
            .values()
            .filter(|s| s.area == area)
            .map(|s| (s.col, s.row))
            .collect()
    }

    /// Columns and rows its cells reach.
    pub fn used(&self, area: &str) -> (u32, u32) {
        self.spots
            .values()
            .filter(|s| s.area == area)
            .fold((0, 0), |(c, r), s| (c.max(s.col + 1), r.max(s.row + 1)))
    }

    /// A cell for a new thread: beside its parent, or at the open edge.
    fn place(&mut self, e: &Entry, as_root: bool) {
        let bands = self.areas.get(&e.area).map_or(1, |a| a.bands.max(1));
        let cols = self.areas.get(&e.area).map_or(BAND, Area::cols);
        let taken = self.taken(&e.area);
        let parent = (!as_root)
            .then(|| e.parent.as_ref().and_then(|p| self.spots.get(p)))
            .flatten()
            .filter(|p| p.area == e.area)
            .map(|p| (p.col, p.row));
        let (col, row) = match parent {
            Some((pc, pr)) => {
                let rows = self.used(&e.area).1 + 1;
                let mut best: Option<(f32, u32, u32)> = None;
                // Always to its right, so a tree only grows that way: the
                // next column if it's free, else the nearest free cell right
                // or just below.
                for r in pr..=rows.max(pr + 1) {
                    for c in (pc + 1)..cols.max(pc + 2) {
                        if taken.contains(&(c, r)) {
                            continue;
                        }
                        let score = (c - pc - 1) as f32 + 1.3 * (r - pr) as f32;
                        if best.is_none_or(|b| score < b.0) {
                            best = Some((score, c, r));
                        }
                    }
                }
                best.map_or((pc + 1, pr), |b| (b.1, b.2))
            }
            None => {
                let mut r = 0;
                loop {
                    if let Some(b) = (0..bands).find(|b| !taken.contains(&(b * BAND, r))) {
                        break (b * BAND, r);
                    }
                    r += 1;
                }
            }
        };
        let at = self.spots.get(&e.id).and_then(|s| s.at);
        self.spots.insert(
            e.id.clone(),
            Spot {
                area: e.area.clone(),
                col,
                row,
                at,
                title: e.title.clone(),
                parent: e.parent.clone(),
                why: e.why.clone(),
                ghost: None,
            },
        );
    }

    /// The first layout's areas: the biggest anchored on the left, the rest
    /// packed beside it, lowest first (the prototype's skyline).
    fn pack(&mut self, order: &[String]) {
        let Some(big) = order.first() else { return };
        let Some(b) = self.areas.get_mut(big) else {
            return;
        };
        b.x = 0.;
        b.y = 0.;
        let (bw, bh) = (b.w, b.h);
        let rest: Vec<&String> = order.iter().skip(1).collect();
        if rest.is_empty() {
            return;
        }
        let sized: Vec<(f32, f32)> = rest
            .iter()
            .map(|k| self.areas.get(*k).map_or((0., 0.), |a| (a.w, a.h)))
            .collect();
        let area: f32 = sized
            .iter()
            .map(|(w, h)| (w + AREA_GAP) * (h + AREA_GAP))
            .sum();
        let x0 = bw + AREA_GAP * 1.6;
        let h0 = bh.max((area / 1.1).sqrt());
        let widest = sized.iter().map(|s| s.0).fold(0., f32::max) + 1.;
        // The skyline: runs of x with the lowest free y over each.
        let mut sky: Vec<(f32, f32, f32)> = vec![(x0, (area / h0 * 1.15).max(widest), 0.)];
        for (k, (w, h)) in rest.iter().zip(sized) {
            let end = sky.last().map_or(x0, |s| s.0 + s.1);
            let mut best: Option<(f32, f32)> = None;
            for &(x, _, _) in &sky {
                if x + w > end + 1. {
                    continue;
                }
                let y = sky
                    .iter()
                    .filter(|s| s.0 < x + w && s.0 + s.1 > x)
                    .map(|s| s.2)
                    .fold(0., f32::max);
                if best.is_none_or(|b| y < b.1 - 1. || ((y - b.1).abs() < 1. && x < b.0)) {
                    best = Some((x, y));
                }
            }
            let (x, y) = best.unwrap_or((x0, sky.iter().map(|s| s.2).fold(0., f32::max)));
            if let Some(a) = self.areas.get_mut(*k) {
                a.x = x;
                a.y = y;
            }
            let (nx, nw, ny) = (x, w + AREA_GAP, y + h + AREA_GAP);
            let mut out = Vec::new();
            for s in sky {
                if s.0 + s.1 <= nx || s.0 >= nx + nw {
                    out.push(s);
                    continue;
                }
                if s.0 < nx {
                    out.push((s.0, nx - s.0, s.2));
                }
                if s.0 + s.1 > nx + nw {
                    out.push((nx + nw, s.0 + s.1 - nx - nw, s.2));
                }
            }
            out.push((nx, nw, ny));
            out.sort_by(|a, b| a.0.total_cmp(&b.0));
            sky = out;
        }
    }

    /// A place for an area added later, clear of every other: beside or
    /// under one, keeping the board about as wide as it is tall.
    fn find_room(&mut self, id: &str) {
        let Some((w, h)) = self.areas.get(id).map(|a| (a.w, a.h)) else {
            return;
        };
        let others: Vec<Rect> = self
            .areas
            .iter()
            .filter(|(k, _)| k.as_str() != id)
            .map(|(_, a)| a.room())
            .collect();
        let mut xs = vec![0.];
        let mut ys = vec![0.];
        for r in &others {
            xs.push(r.right() + AREA_GAP);
            ys.push(r.bottom() + AREA_GAP);
        }
        let clear = |x: f32, y: f32| {
            let me = Rect::new(
                x - AREA_GAP / 2.,
                y - AREA_GAP / 2.,
                w + AREA_GAP,
                h + AREA_GAP,
            );
            others.iter().all(|r| {
                me.right() <= r.x || me.x >= r.right() || me.bottom() <= r.y || me.y >= r.bottom()
            })
        };
        let mut best: Option<(f32, f32, f32)> = None;
        for &x in &xs {
            for &y in &ys {
                if !clear(x, y) {
                    continue;
                }
                let cost = (x + w).max((y + h) * 1.6) + (x + y) * 0.01;
                if best.is_none_or(|b| cost < b.0) {
                    best = Some((cost, x, y));
                }
            }
        }
        if let (Some((_, x, y)), Some(a)) = (best, self.areas.get_mut(id)) {
            a.x = x;
            a.y = y;
        }
    }

    /// Tidy: the ghosts go, and each area's trees are laid out again in the
    /// order they're in, through the same rules new threads go by.
    pub fn tidy(&mut self, entries: &[Entry]) {
        self.spots.retain(|_, s| s.ghost.is_none());
        let by_id: HashMap<&str, &Entry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
        let areas: Vec<String> = self.areas.keys().cloned().collect();
        for area in areas {
            let keep: Vec<(String, Spot)> = self
                .spots
                .iter()
                .filter(|(_, s)| s.area == area)
                .map(|(id, s)| (id.clone(), s.clone()))
                .collect();
            for (id, _) in &keep {
                self.spots.remove(id);
            }
            let order = |a: &Spot, b: &Spot| a.row.cmp(&b.row).then(a.col.cmp(&b.col));
            let ids: HashSet<&str> = keep.iter().map(|(id, _)| id.as_str()).collect();
            let mut roots: Vec<&(String, Spot)> = keep
                .iter()
                .filter(|(_, s)| !s.parent.as_deref().is_some_and(|p| ids.contains(p)))
                .collect();
            roots.sort_by(|a, b| order(&a.1, &b.1));
            let mut stack: Vec<(&(String, Spot), bool)> =
                roots.into_iter().rev().map(|r| (r, true)).collect();
            while let Some(((id, spot), root)) = stack.pop() {
                let e = by_id.get(id.as_str()).map_or_else(
                    || Entry {
                        id: id.clone(),
                        title: spot.title.clone(),
                        area: area.clone(),
                        parent: spot.parent.clone(),
                        why: spot.why.clone(),
                        ..Entry::default()
                    },
                    |e| (*e).clone(),
                );
                self.place(&e, root);
                if let Some(s) = self.spots.get_mut(id) {
                    s.at = spot.at;
                }
                let mut kids: Vec<&(String, Spot)> = keep
                    .iter()
                    .filter(|(_, s)| s.parent.as_deref() == Some(id.as_str()))
                    .collect();
                kids.sort_by(|a, b| order(&a.1, &b.1));
                stack.extend(kids.into_iter().rev().map(|k| (k, false)));
            }
        }
        // Areas whose project has gone and that hold nothing.
        let used: HashSet<String> = self.spots.values().map(|s| s.area.clone()).collect();
        let live: HashSet<&str> = entries.iter().map(|e| e.area.as_str()).collect();
        self.areas
            .retain(|k, _| used.contains(k) || live.contains(k.as_str()) || k == LOOSE);
    }

    /// Where a thread's window is on the board.
    pub fn rect(&self, id: &str) -> Option<Rect> {
        let s = self.spots.get(id)?;
        let a = self.areas.get(&s.area)?;
        let (x, y) = s.at.unwrap_or((
            a.x + AREA_PAD + s.col as f32 * CELL_W,
            a.y + AREA_PAD + s.row as f32 * CELL_H,
        ));
        let h = if s.ghost.is_some() { GHOST_H } else { WIN_H };
        Some(Rect::new(x, y, WIN_W, h))
    }

    /// An area's ground: as big as its cells reach, or one window's room
    /// while it's empty.
    pub fn ground(&self, area: &str) -> Option<Rect> {
        let a = self.areas.get(area)?;
        let (c, r) = self.used(area);
        let (c, r) = (c.max(1), r.max(1));
        Some(Rect::new(
            a.x,
            a.y,
            c as f32 * CELL_W - GAP_X + AREA_PAD * 2.,
            r as f32 * CELL_H - GAP_Y + AREA_PAD * 2.,
        ))
    }

    /// Everything on the board, for "see it all".
    pub fn bounds(&self) -> Option<Rect> {
        let mut out: Option<Rect> = None;
        for k in self.areas.keys() {
            let g = self.ground(k)?;
            out = Some(out.map_or(g, |o| o.union(&g)));
        }
        for id in self.spots.keys() {
            if let Some(r) = self.rect(id) {
                out = Some(out.map_or(r, |o| o.union(&r)));
            }
        }
        out
    }

    /// The window under a point on the board, the one drawn last first.
    pub fn at(&self, point: (f32, f32)) -> Option<String> {
        self.spots
            .keys()
            .rev()
            .find(|id| self.rect(id).is_some_and(|r| r.contains(point)))
            .cloned()
    }

    /// Moves a window by hand.
    pub fn move_to(&mut self, id: &str, at: (f32, f32)) {
        if let Some(s) = self.spots.get_mut(id) {
            s.at = Some(at);
        }
    }

    /// The arrows: from each thread to the ones it started in its own area.
    pub fn edges(&self) -> Vec<Edge> {
        let mut kids: BTreeMap<&str, Vec<(&str, &Spot)>> = BTreeMap::new();
        for (id, s) in &self.spots {
            let Some(p) = s.parent.as_deref() else {
                continue;
            };
            if self.spots.get(p).is_some_and(|ps| ps.area == s.area) {
                kids.entry(p).or_default().push((id.as_str(), s));
            }
        }
        let mut out = Vec::new();
        for (p, mut list) in kids {
            list.sort_by(|a, b| a.1.row.cmp(&b.1.row).then(a.1.col.cmp(&b.1.col)));
            let n = list.len() as f32;
            for (i, (c, _)) in list.into_iter().enumerate() {
                out.push(Edge {
                    parent: p.to_owned(),
                    child: c.to_owned(),
                    k: i as f32 - (n - 1.) / 2.,
                });
            }
        }
        out
    }

    /// An arrow's curve, from the parent's right side to the child's title
    /// bar. `inv` keeps strokes and gaps readable zoomed out.
    pub fn curve(&self, edge: &Edge, inv: f32) -> Option<Curve> {
        let p = self.rect(&edge.parent)?;
        let c = self.rect(&edge.child)?;
        let ghost = |id: &str| self.spots.get(id).is_some_and(|s| s.ghost.is_some());
        let sy =
            p.y + if ghost(&edge.parent) {
                GHOST_H / 2.
            } else {
                HEADER_H + 120.
            } + edge.k * 18. * inv;
        let start = (p.right() - 6., sy);
        let end = (
            c.x - 4.,
            c.y + if ghost(&edge.child) {
                GHOST_H / 2.
            } else {
                HEADER_H / 2.
            },
        );
        let dx = ((end.0 - start.0).abs() * 0.5).max(120.);
        let c1 = (start.0 + dx, start.1);
        let c2 = (end.0 - dx, end.1);
        let mid = (
            (start.0 + 3. * c1.0 + 3. * c2.0 + end.0) / 8.,
            (start.1 + 3. * c1.1 + 3. * c2.1 + end.1) / 8.,
        );
        Some(Curve {
            start,
            c1,
            c2,
            end,
            mid,
        })
    }
}

/// How many bands an area of `n` threads gets: about square.
fn bands_for(n: usize) -> u32 {
    if n <= 2 {
        return 1;
    }
    ((n as f32 * CELL_H / (BAND as f32 * CELL_W)).sqrt().round() as u32).max(1)
}

/// Words for an arrow, wrapped at about `width` characters, three lines at most.
pub fn wrap_words(text: &str, width: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for w in text.split_whitespace() {
        if !cur.is_empty() && cur.len() + 1 + w.len() > width {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(w);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    if out.len() > 3 {
        out.truncate(3);
        if let Some(last) = out.last_mut() {
            last.push('…');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str, area: &str, parent: Option<&str>, t: i64) -> Entry {
        Entry {
            id: id.into(),
            title: format!("Thread {id}"),
            area: area.into(),
            area_title: area.into(),
            parent: parent.map(str::to_owned),
            created_ms: t,
            ..Entry::default()
        }
    }

    fn cell(l: &Layout, id: &str) -> (u32, u32) {
        let s = &l.spots[id];
        (s.col, s.row)
    }

    #[test]
    fn a_child_sits_beside_its_parent_and_the_biggest_area_is_on_the_left() {
        let list = vec![
            e("a", "tb", None, 1),
            e("b", "tb", Some("a"), 2),
            e("c", "tb", Some("a"), 3),
            e("d", "tb", None, 4),
            e("x", "small", None, 5),
        ];
        let mut l = Layout::default();
        let ch = l.sync(&list, &[], 10);
        assert!(ch.arrived.is_empty(), "the first look isn't an arrival");
        assert_eq!(cell(&l, "a"), (0, 0));
        assert_eq!(cell(&l, "b"), (1, 0));
        assert_eq!(cell(&l, "c"), (1, 1));
        assert_eq!((l.areas["tb"].x, l.areas["tb"].y), (0., 0.));
        assert!(l.areas["small"].x > l.areas["tb"].w);
        let edges = l.edges();
        assert_eq!(edges.len(), 2);
        assert_eq!((edges[0].k, edges[1].k), (-0.5, 0.5));
    }

    #[test]
    fn a_parent_is_placed_before_its_child_even_when_it_looks_newer() {
        let list = vec![e("kid", "tb", Some("boss"), 1), e("boss", "tb", None, 5)];
        let mut l = Layout::default();
        l.sync(&list, &[], 10);
        assert_eq!(cell(&l, "boss"), (0, 0));
        assert_eq!(cell(&l, "kid"), (1, 0));
    }

    #[test]
    fn an_arrival_moves_nothing_else() {
        let mut list = vec![e("a", "tb", None, 1), e("b", "tb", Some("a"), 2)];
        let mut l = Layout::default();
        l.sync(&list, &[], 10);
        let before: Vec<Rect> = ["a", "b"].iter().filter_map(|id| l.rect(id)).collect();
        let area = l.areas["tb"].clone();
        list.push(e("c", "tb", Some("b"), 3));
        list.push(e("n", "new", None, 4));
        let ch = l.sync(&list, &[], 20);
        assert_eq!(ch.arrived, vec!["c".to_string(), "n".to_string()]);
        assert_eq!(ch.glow, vec!["tb".to_string(), "new".to_string()]);
        let after: Vec<Rect> = ["a", "b"].iter().filter_map(|id| l.rect(id)).collect();
        assert_eq!(before, after);
        assert_eq!(l.areas["tb"], area);
        assert_eq!(cell(&l, "c"), (2, 0));
        // The new area is clear of the old one's room.
        let (n, t) = (l.areas["new"].room(), l.areas["tb"].room());
        assert!(n.x >= t.right() || n.y >= t.bottom());
    }

    #[test]
    fn archived_threads_ghost_until_their_whole_tree_has_gone() {
        let mut list = vec![e("a", "tb", None, 1), e("b", "tb", Some("a"), 2)];
        let mut l = Layout::default();
        l.sync(&list, &[], 10);
        list.retain(|x| x.id != "b");
        let ch = l.sync(&list, &[], 20);
        assert_eq!(ch.archived, vec!["b".to_string()]);
        assert!(l.spots["b"].ghost.is_some());
        assert_eq!(l.rect("b").map(|r| r.h), Some(GHOST_H));
        assert_eq!(l.edges().len(), 1, "a ghost keeps its arrow");
        l.sync(&list, &[], 20 + GHOST_GRACE_MS * 2);
        assert!(l.spots.contains_key("b"), "its parent's still live");
        list.clear();
        l.sync(&list, &[], 100);
        assert!(l.spots.contains_key("a"));
        l.sync(&list, &[], 100 + GHOST_GRACE_MS);
        assert!(l.spots.is_empty(), "the whole tree went, after the grace");
        // The hole is reused.
        list.push(e("z", "tb", None, 200));
        l.sync(&list, &[], 200 + GHOST_GRACE_MS);
        assert_eq!(cell(&l, "z"), (0, 0));
    }

    #[test]
    fn automated_threads_wait_in_the_strip_until_they_need_mike() {
        let mut s = e("s", "tb", None, 1);
        s.automated = true;
        let mut list = vec![e("a", "tb", None, 0), s];
        let mut l = Layout::default();
        l.sync(&list, &[], 10);
        assert!(!l.spots.contains_key("s"));
        assert_eq!(l.strip(&list).len(), 1);
        list[1].waiting = true;
        let ch = l.sync(&list, &[], 20);
        assert_eq!(ch.arrived, vec!["s".to_string()]);
        assert!(l.strip(&list).is_empty());
        list[1].waiting = false;
        l.sync(&list, &[], 30);
        assert!(l.spots.contains_key("s"), "once on the board it stays");
    }

    #[test]
    fn tidy_closes_the_gaps_and_keeps_hand_moves() {
        let mut list = vec![
            e("a", "tb", None, 1),
            e("b", "tb", None, 2),
            e("c", "tb", None, 3),
        ];
        let mut l = Layout::default();
        l.sync(&list, &[], 10);
        assert_eq!(cell(&l, "c"), (0, 2));
        l.move_to("b", (5000., 5000.));
        list.remove(0);
        l.sync(&list, &[], 20);
        assert!(l.spots["a"].ghost.is_some());
        l.tidy(&list);
        assert!(!l.spots.contains_key("a"));
        assert_eq!(cell(&l, "b"), (0, 0));
        assert_eq!(cell(&l, "c"), (0, 1));
        assert_eq!(l.rect("b").map(|r| (r.x, r.y)), Some((5000., 5000.)));
    }

    #[test]
    fn it_keeps_between_launches() {
        let list = vec![e("a", "tb", None, 1), e("b", "tb", Some("a"), 2)];
        let mut l = Layout::default();
        l.sync(&list, &[("p".into(), "Empty".into(), false)], 10);
        assert!(
            !l.areas.contains_key("p"),
            "a project with nothing live has no area"
        );
        l.camera = Some([0.3, 10., 20.]);
        let back = Layout::from_json(&l.to_json());
        assert_eq!(back, l);
        assert_eq!(
            Layout::from_json(&serde_json::json!("junk")),
            Layout::default()
        );
    }

    #[test]
    fn entries_take_their_parents_project_and_skip_the_archived() {
        let list: Vec<ThreadSummary> = serde_json::from_value(serde_json::json!([
            { "id": "p", "title": "Parent", "projects": [{ "id": "tb", "title": "Threadbear" }], "createdAt": "2026-11-24T01:00:00Z" },
            { "id": "c", "title": "Child", "startedBy": { "kind": "thread", "label": "Agent", "threadId": "p", "why": "Mike asked" }, "createdAt": "2026-11-24T02:00:00Z" },
            { "id": "s", "title": "Nightly", "startedBy": { "kind": "schedule", "label": "Schedule" }, "createdAt": "2026-11-24T03:00:00Z" },
            { "id": "z", "title": "Gone", "archivedAt": "2026-11-24T04:00:00Z" }
        ]))
        .unwrap_or_default();
        let out = entries(&list);
        assert_eq!(out.len(), 3);
        assert_eq!(out[1].area, "tb");
        assert_eq!(out[1].parent.as_deref(), Some("p"));
        assert_eq!(out[1].why.as_deref(), Some("Mike asked"));
        assert!(out[2].automated);
        assert_eq!(out[2].area, LOOSE);
    }

    #[test]
    fn words_wrap_into_three_lines_at_most() {
        assert_eq!(
            wrap_words("Mike asked: turn port findings into evals", 22),
            vec!["Mike asked: turn port", "findings into evals"]
        );
        assert_eq!(wrap_words(&"word ".repeat(40), 10).len(), 3);
    }
}
