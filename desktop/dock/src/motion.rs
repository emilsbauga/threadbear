// The springs and tweens a dragged panel moves by: the lift, the slide of the
// drop preview, the landing. They run on GPUI's frames, computed from elapsed
// time (SpringConfig's closed form), so a busy main thread drops frames
// instead of running slowly: the same property the Swift ghost gets from
// withAnimation. Their own module, apart from the overlay that draws with
// them, so the view holding them needn't use its overlay's code
// (deslop-please's module-cycle).
use gpui_kit::*;
use std::time::Instant;
use threadbear_dock_layout as dl;

/// A spring from one value to another, as SwiftUI's
/// `spring(response:dampingFraction:)`, sampled by time. No interruption or
/// retargeting: each run is one flight.
#[derive(Clone, Copy)]
pub struct SpringRun {
    config: SpringConfig,
    from: f32,
    to: f32,
    started: Instant,
}

/// SwiftUI's response and damping fraction as GPUI's physical spring: response
/// is the period of the undamped spring, so ω = 2π / response.
fn spring_config(spring: dl::Spring) -> SpringConfig {
    let omega = (2.0 * std::f64::consts::PI) / spring.response;
    SpringConfig::new(
        (omega * omega) as f32,
        (2.0 * spring.damping_fraction * omega) as f32,
        1.0,
    )
}

impl SpringRun {
    pub fn new(spring: dl::Spring, from: f32, to: f32) -> Self {
        Self {
            config: spring_config(spring),
            from,
            to,
            started: Instant::now(),
        }
    }

    /// Where it is now. Computed from the elapsed time in one analytic step.
    pub fn value(&self, now: Instant) -> f32 {
        let t = now.saturating_duration_since(self.started).as_secs_f32();
        self.config
            .step(
                SpringState {
                    position: self.from,
                    velocity: 0.,
                },
                self.to,
                t,
            )
            .position
    }

    pub fn settled(&self, now: Instant) -> bool {
        let t = now.saturating_duration_since(self.started).as_secs_f32();
        let s = self.config.step(
            SpringState {
                position: self.from,
                velocity: 0.,
            },
            self.to,
            t,
        );
        (s.position - self.to).abs() < 0.002 && s.velocity.abs() < 0.02
    }
}

/// A rect moving to another over a set time, ease-out (the drop preview's
/// `Animation.snappy(duration: 0.16)`).
#[derive(Clone, Copy)]
pub struct Tween {
    from: dl::Rect,
    to: dl::Rect,
    started: Instant,
    seconds: f64,
}

impl Tween {
    pub fn new(from: dl::Rect, to: dl::Rect, seconds: f64) -> Self {
        Self {
            from,
            to,
            started: Instant::now(),
            seconds,
        }
    }

    pub fn value(&self, now: Instant) -> dl::Rect {
        if self.seconds <= 0. {
            return self.to;
        }
        let t = (now.saturating_duration_since(self.started).as_secs_f64() / self.seconds).min(1.);
        // Ease-out, the snappy shape: fast then settling.
        let p = 1. - (1. - t).powi(3);
        lerp_rect(self.from, self.to, p)
    }

    pub fn settled(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.started).as_secs_f64() >= self.seconds
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

pub(crate) fn lerp_rect(a: dl::Rect, b: dl::Rect, t: f64) -> dl::Rect {
    dl::Rect::new(
        lerp(a.x, b.x, t),
        lerp(a.y, b.y, t),
        lerp(a.width, b.width, t),
        lerp(a.height, b.height, t),
    )
}

/// The ghost flying to where the panel landed, or home.
#[derive(Clone)]
pub struct LandingRun {
    pub from: dl::Rect,
    pub to: dl::Rect,
    pub panel: String,
    pub source_size: dl::Size,
    spring: SpringRun,
    /// Set when the 300 ms is up and the ghost starts fading.
    pub fading_since: Option<Instant>,
}

impl LandingRun {
    pub fn new(from: dl::Rect, to: dl::Rect, panel: String, source_size: dl::Size) -> Self {
        Self {
            from,
            to,
            panel,
            source_size,
            spring: SpringRun::new(dl::SETTLE, 0., 1.),
            fading_since: None,
        }
    }

    pub(crate) fn progress(&self, now: Instant) -> f64 {
        self.spring.value(now) as f64
    }
}
