//! Sign in… on the signed-out line: the Terminal script that runs a CLI's own
//! sign-in for one login, as the Swift app's `SignIn` writes it. The same way
//! the runner starts that CLI: claude-main with no CLAUDE_CONFIG_DIR (so it's
//! the login in the Keychain the runner reads), the other Claude logins with
//! their folder, and Codex with CODEX_HOME.
//!
//! Everything that comes from outside the app (a login's name and folder, the
//! CLI's path) is quoted or printed as data, never run: a login's provider
//! once went into the script as its name, shell and all (Daybreak, 7 Nov).

/// The thread's login to sign in again, or None: never for another runner's
/// thread (that Mac's login is signed in on that Mac, and nothing its runner
/// says may pick what runs here). Missing metadata never selects a fallback
/// login or guesses its credential folder.
pub fn account_for(account_id: &str, provider: &str, remote: bool, known: Option<SignInAccount>) -> Option<SignInAccount> {
    if remote || account_id.is_empty() {
        return None;
    }
    let known = known?;
    if known.id != account_id { return None; }
    if !provider.is_empty() && known.provider != provider { return None; }
    known.can_sign_in().then_some(known)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignInAccount {
    pub id: String,
    pub provider: String,
    pub title: String,
    pub config_dir: String,
}

impl SignInAccount {
    pub fn can_sign_in(&self) -> bool {
        match self.provider.as_str() {
            "claude" | "" => self.id == "claude-main" || !self.config_dir.trim().is_empty(),
            // codex-main's CODEX_HOME can also be customized by the runner.
            "codex" => !self.config_dir.trim().is_empty(),
            "pi" => !self.config_dir.trim().is_empty(),
            _ => true,
        }
    }
}

/// A provider's own sign-in, as `ProviderInfo.loginCommand` has it.
pub fn login_command(provider: &str) -> &'static str {
    match provider {
        "codex" => "codex login",
        "cursor" => "agent login",
        "opencode" => "opencode auth login",
        "claude" | "" => "claude auth login",
        _ => "",
    }
}

/// `s` in single quotes for zsh, with any quote in it closed and reopened.
pub fn quoted(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A login's name on one line, for the script's first line of output: data
/// printed by printf, never shell source.
pub fn one_line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).take(200).collect()
}

/// An account id as part of a file name: letters, digits, - and _.
pub fn file_safe(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(64).collect()
}

/// The script. `cli_path` is the binary the runner starts for new sessions
/// (Codex is often Threadbear's own copy, not on the PATH); empty uses the
/// PATH's.
pub fn script(account: &SignInAccount, cli_path: &str) -> String {
    script_with_command(account, cli_path, login_command(&account.provider))
}

/// Pi's supported interactive login, isolated to the selected profile.
pub fn pi_script(config_dir: &str, executable: &str, provider: &str) -> String {
    let binary = quoted(if executable.is_empty() { "pi" } else { executable });
    let guidance = quoted(&format!("In Pi, run /login {} to sign in.", one_line(provider)));
    format!("#!/bin/zsh -l\nprintf '%s\\n' {guidance}\nPI_CODING_AGENT_DIR={} {binary} --no-tools --no-extensions --no-mcp --no-skills --no-context-files\n", quoted(config_dir))
}

/// The hello's command is a program and arguments, never shell source.
pub fn script_with_command(account: &SignInAccount, cli_path: &str, command: &str) -> String {
    script_named(account, cli_path, command, &crate::logins::provider_title(&account.provider))
}

const DONE_TAIL: &str = "echo\necho \"Done. Go back to Threadbear and press Send again. You can close this window.\"\n";

pub fn script_named(account: &SignInAccount, cli_path: &str, command: &str, name: &str) -> String {
    if !account.can_sign_in() || command.trim().is_empty() {
        return "#!/bin/zsh -l\nprintf '%s\\n' 'Sign-in is unavailable for this login. Refresh the accounts in Threadbear.'\n".into();
    }
    let codex = account.provider == "codex";
    let mut env = String::new();
    if codex && !account.config_dir.is_empty() {
        env = format!("CODEX_HOME={} ", quoted(&account.config_dir));
    }
    if (account.provider == "claude" || account.provider.is_empty()) && account.id != "claude-main" && !account.config_dir.is_empty() {
        env = format!("CLAUDE_CONFIG_DIR={} ", quoted(&account.config_dir));
    }
    // "claude auth login": the program, then what it's asked to do.
    let mut words = command.split_whitespace();
    let program = words.next().unwrap_or("claude");
    let argument = |s: &str| {
        if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c)) { s.to_owned() } else { quoted(s) }
    };
    let command = words.map(argument).collect::<Vec<_>>().join(" ");
    let binary = if cli_path.is_empty() { argument(program) } else { quoted(cli_path) };
    let first = quoted(&format!("Signing in to {name} for Threadbear ({}).", one_line(&account.title)));
    format!(
        "#!/bin/zsh -l\nexport PATH=\"$HOME/.local/bin:$PATH\"\nprintf '%s\\n' {first}\necho\n{env}{binary} {command}\n{DONE_TAIL}"
    )
}

/// The file a login's year-long token is kept in, in its own folder: the
/// runner's year-token.ts reads it.
pub const TOKEN_FILE: &str = "threadbear-token.json";

/// Year-long token…: Terminal on `claude setup-token` for one Claude login,
/// through claude_token.py, which takes the token from what it prints and
/// writes it to the login's TOKEN_FILE. The helper is part of this app, so
/// nothing a runner says picks what runs; the login's folder and the CLI's
/// path are quoted, as in `script`.
pub fn token_script(account: &SignInAccount, cli_path: &str) -> String {
    if account.provider != "claude" && !account.provider.is_empty() || !account.can_sign_in() {
        return "#!/bin/zsh -l\nprintf '%s\\n' 'A year-long token is only for Claude logins on this Mac.'\n".into();
    }
    let folder = if account.config_dir.trim().is_empty() { "$HOME/.claude".to_owned() } else { quoted(account.config_dir.trim_end_matches('/')) };
    let binary = if cli_path.is_empty() { "claude".to_owned() } else { quoted(cli_path) };
    let first = quoted(&format!("Making a year-long Claude token for Threadbear ({}).", one_line(&account.title)));
    format!(
        "#!/bin/zsh -l\nexport PATH=\"$HOME/.local/bin:$PATH\"\nprintf '%s\\n' {first} 'Sign in as that account on the page that opens.'\necho\nhelper=$(cat <<'THREADBEAR_PY'\n{}THREADBEAR_PY\n)\n/usr/bin/python3 -I -c \"$helper\" {binary} {folder}/{TOKEN_FILE}\n",
        include_str!("claude_token.py")
    )
}

/// Sign in, then a year-long token for the same login, in one Terminal
/// window: the setup cards' Sign in… and Add (Mike, 18 Nov: "Always, at
/// sign-in"). The sign-in gives the login its address; the token keeps it
/// running for a year rather than 28 days. Anything but a Claude login
/// gets the plain sign-in.
pub fn sign_in_for_a_year_script(account: &SignInAccount, cli_path: &str, command: &str, name: &str) -> String {
    let sign_in = script_named(account, cli_path, command, name);
    if !(account.provider == "claude" || account.provider.is_empty()) || !account.can_sign_in() {
        return sign_in;
    }
    let Some(head) = sign_in.strip_suffix(DONE_TAIL) else { return sign_in };
    let token = token_script(account, cli_path);
    // The token script without its own first two lines (#! and PATH).
    let body = token.splitn(3, '\n').nth(2).unwrap_or_default();
    format!("{head}echo\nprintf '%s\\n' 'Now a token, so this login lasts a year rather than 28 days.'\n{body}echo\necho \"Done. Go back to Threadbear. You can close this window.\"\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(id: &str, provider: &str, title: &str, config_dir: &str) -> SignInAccount {
        SignInAccount { id: id.into(), provider: provider.into(), title: title.into(), config_dir: config_dir.into() }
    }

    #[test]
    fn the_main_claude_login_sets_no_config_folder() {
        let s = script(&account("claude-main", "claude", "me@example.com", "/Users/x/.claude"), "/Users/x/.local/bin/claude");
        assert!(s.contains("\n'/Users/x/.local/bin/claude' auth login\n"), "{s}");
        assert!(!s.contains("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn another_claude_login_uses_its_folder() {
        let s = script(&account("claude-1", "claude", "two", "/Users/x/Library/Application Support/Threadbear/accounts/claude-1"), "");
        assert!(s.contains("CLAUDE_CONFIG_DIR='/Users/x/Library/Application Support/Threadbear/accounts/claude-1' claude auth login"), "{s}");
    }

    #[test]
    fn codex_uses_codex_home_and_quotes_it() {
        let s = script(&account("codex-1", "codex", "c", "/tmp/it's here"), "/opt/codex");
        assert!(s.contains("CODEX_HOME='/tmp/it'\\''s here' '/opt/codex' login"), "{s}");
        assert!(s.starts_with("#!/bin/zsh -l\n"));
    }

    #[test]
    fn another_runners_thread_never_picks_a_sign_in_here() {
        assert_eq!(account_for("claude-main", "claude", true, Some(account("claude-main", "claude", "me", ""))), None, "even with a login of that id here");
        assert_eq!(account_for("claude-main", "claude$(touch /tmp/x)", false, None), None, "no such provider: no sign-in");
        assert_eq!(account_for("codex-main", "codex", false, None), None, "missing metadata must not guess a login's folder");
    }

    #[test]
    fn a_logins_name_is_printed_never_run() {
        let title = "claude$(touch injected) `touch injected` \"q\" 'q' \\ $HOME\nsecond line; touch injected";
        let s = script(&account("claude-main", "claude", title, ""), "/usr/bin/true");
        let printed = s.lines().find(|l| l.starts_with("printf")).unwrap();
        // The whole name is inside one pair of single quotes, its own quote
        // closed and reopened, and the newline gone.
        assert_eq!(printed, format!("printf '%s\\n' {}", quoted(&format!("Signing in to Claude for Threadbear ({}).", one_line(title)))));
        assert!(!printed.contains('\n'));
        assert_eq!(file_safe("../../evil id"), "______evil_id");
    }

    #[test]
    fn a_year_long_token_runs_setup_token_through_the_helper_into_the_login_folder() {
        let s = token_script(&account("claude-1", "claude", "o'ne@example.com", "/Users/x/Token Stats/claude-1"), "/Users/x/.local/bin/claude");
        assert!(s.contains("\n/usr/bin/python3 -I -c \"$helper\" '/Users/x/.local/bin/claude' '/Users/x/Token Stats/claude-1'/threadbear-token.json\n"), "{s}");
        assert!(s.contains("o'\\''ne@example.com"), "the name is quoted");
        assert!(s.contains("setup-token") && s.contains("\nTHREADBEAR_PY\n)"), "the helper, whole");
        assert_eq!(include_str!("claude_token.py").lines().filter(|l| *l == "THREADBEAR_PY").count(), 0);
        let main = token_script(&account("claude-main", "claude", "me@example.com", ""), "");
        assert!(main.contains(" claude $HOME/.claude/threadbear-token.json\n"), "{main}");
        assert!(token_script(&account("codex-1", "codex", "c", "/x"), "").contains("only for Claude"));
    }

    #[test]
    fn signing_in_for_a_year_signs_in_then_makes_the_token_in_the_same_folder() {
        let s = sign_in_for_a_year_script(&account("claude-2", "claude", "two", "/x/accounts/claude-2"), "/bin/claude", "claude auth login", "Claude");
        let login = s.find("CLAUDE_CONFIG_DIR='/x/accounts/claude-2' '/bin/claude' auth login").expect(&s);
        let token = s.find("'/bin/claude' '/x/accounts/claude-2'/threadbear-token.json").expect(&s);
        assert!(login < token, "{s}");
        assert_eq!(s.matches("#!/bin/zsh").count(), 1);
        assert!(!s.contains("press Send again"));
        // Codex has no year-long token: just its sign-in.
        let codex = sign_in_for_a_year_script(&account("codex-main", "codex", "c", "/x/.codex"), "", "codex login", "Codex");
        assert!(!codex.contains("threadbear-token.json") && codex.contains("codex login"), "{codex}");
    }
}
