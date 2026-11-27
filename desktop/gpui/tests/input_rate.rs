//! Input rate tracker tests.
//!
//! Verifies that scroll events immediately activate high-rate input mode
//! so that scrolling an inactive or freshly woken window does not hit the
//! 33.3 ms throttle on Frame 2 waiting for a burst of 6 events.

use gpui_kit::InputRateTracker;

#[test]
fn test_input_rate_tracker_scroll_immediately_high_rate() {
    let mut tracker = InputRateTracker::default();
    assert!(!tracker.is_high_rate(), "tracker should start inactive");

    // A single non-scroll input does not immediately trigger high rate.
    tracker.record_input(false);
    assert!(
        !tracker.is_high_rate(),
        "single non-scroll event should not activate high-rate mode"
    );

    // A single scroll input immediately activates high rate to avoid inactive throttle hitching.
    tracker.record_input(true);
    assert!(
        tracker.is_high_rate(),
        "single scroll event should immediately activate high-rate mode"
    );
}
