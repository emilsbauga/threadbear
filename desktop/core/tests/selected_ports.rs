use serde_json::json;
use threadbear_core::{librarian, logins, sign_in, slash};

#[test]
fn pi_profiles_are_metadata_until_the_runner_advertises_an_account() {
    let hello = json!({"piProfiles":[{"id":"local","engine":"pi","title":"Local Pi","executable":"/opt/pi","configDir":"/profiles/local","connection":{"provider":"lmstudio","model":"local-model"},"capabilities":{"threads":false}}],"accounts":[]});
    let known = logins::RunnerLogins::from_hello(&hello);
    assert_eq!(known.pi_profiles[0].connection.model, "local-model");
    assert!(!known.pi_profiles[0].capabilities.threads);
    assert!(known.accounts.is_empty());
    assert!(logins::RunnerLogins::from_hello(&json!({}))
        .pi_profiles
        .is_empty());
}

#[test]
fn pi_accounts_keep_their_model_and_do_not_offer_claude_effort_or_aliases() {
    let known = logins::RunnerLogins::from_hello(
        &json!({"accounts":[{"id":"pi:local","provider":"pi","piProfileId":"local","executable":"/opt/pi","configDir":"/profiles/local","defaultModel":"local-model","connection":{"provider":"lmstudio","model":"local-model"}}]}),
    );
    let account = known.account("pi:local").unwrap();
    assert_eq!(account.pi_profile_id.as_deref(), Some("local"));
    assert!(logins::effort_levels(None, &[], "pi").is_empty());
    let reasoning = logins::ModelChoice {
        id: "reasoner".into(),
        effort_levels: vec!["low".into(), "high".into()],
        ..Default::default()
    };
    assert_eq!(
        logins::effort_levels(Some("reasoner"), &[reasoning], "pi"),
        ["low", "high"]
    );
    let rows = logins::picker_rows(&[], account.default_model.as_deref(), None, "", "pi");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "local-model");
}

#[test]
fn pi_login_uses_the_selected_profile_and_interactive_login() {
    let script = sign_in::pi_script("/profiles/it's local", "/opt/Pi Agent/pi", "openrouter");
    assert!(script.contains("/login openrouter"));
    assert!(script.contains("PI_CODING_AGENT_DIR='/profiles/it'\\''s local' '/opt/Pi Agent/pi'"));
    assert!(script.contains("--no-tools --no-extensions --no-mcp --no-skills --no-context-files"));
    assert!(!script.contains("auth login"));
}

#[test]
fn evolving_title_policy_is_optional_and_backlog_reviews_have_plain_words() {
    assert_eq!(
        librarian::Status::decode(&json!({"evolvingTitles":false})).evolving_titles,
        Some(false)
    );
    assert_eq!(librarian::Status::decode(&json!({})).evolving_titles, None);
    assert_eq!(
        librarian::reason_text(librarian::Reason::Backlog),
        "Its saved prompt needs a look"
    );
}

#[test]
fn displayed_skill_titles_rank_before_internal_names_and_descriptions() {
    let commands = slash::decode_commands(&json!({"commands":[
        {"name":"review-in-description","title":"Other task","description":"Review changes","source":"skill"},
        {"name":"review","title":"Review old work","source":"skill"},
        {"name":"audit","title":"Review","source":"skill"}
    ]}));
    assert_eq!(
        slash::matches(&commands, "review", slash::Category::All, &[])
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["audit", "review", "review-in-description"]
    );
    assert_eq!(
        slash::matches(&commands, "other", slash::Category::All, &[])[0].name,
        "review-in-description"
    );
    let equal = slash::decode_commands(&json!({"commands":[
        {"name":"z","title":"Review zebra","source":"skill"},
        {"name":"a","title":"Review apple","source":"skill"}
    ]}));
    assert_eq!(
        slash::matches(&equal, "review", slash::Category::All, &[])[0].name,
        "a"
    );
}
