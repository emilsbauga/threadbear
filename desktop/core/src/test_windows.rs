//! Launch policy for scripted Mac test windows, never the installed app.
pub fn hidden(settings: &serde_json::Value, explicit: Option<&str>) -> bool {
    match explicit {
        Some("1") => true,
        Some("0") => false,
        _ => settings["hideTestingWindows"].as_bool().unwrap_or(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn launch_policy_defaults_hidden_but_respects_the_switch_and_explicit_runs() {
        assert!(hidden(&json!({}), None));
        assert!(hidden(&json!({"hideTestingWindows":"bad"}), None));
        assert!(!hidden(&json!({"hideTestingWindows":false}), None));
        assert!(hidden(&json!({"hideTestingWindows":false}), Some("1")));
        assert!(!hidden(&json!({"hideTestingWindows":true}), Some("0")));
    }
}
