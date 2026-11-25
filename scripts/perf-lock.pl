#!/usr/bin/perl
# One build or measurement per host. Both files stay locked until the hangup
# guard has stopped the command's tree, including Desk Runner's GUI child
# (or, when lsof alone can't confirm that for 10 minutes, until cleanup gives
# up: perf-children.pl).
# Usage: perl scripts/perf-lock.pl <pidfile|-> <command...>
#        perl scripts/perf-lock.pl --desk <pidfile> <command...>
#        perl scripts/perf-lock.pl --try <pidfile|-> <command...>  (75 if busy)
#        perl scripts/perf-lock.pl --build [--try] - <command...>
#
# --build is a plain build (remote.sh --build), which may share the host with
# other builds, up to the number in ~/.cache/threadbear-check/builds-at-once
# there (1, so one at a time, when it's missing). Mike asked on 18 Nov, after
# threads queued behind each other's builds on Tinker Desk all day. Builds
# hold both locks shared, plus one of that many build lanes; measurements,
# Desk Runner runs and checks still hold them alone. macOS's flock grants a
# shared lock even while an exclusive one is waiting, so a stream of
# overlapping builds would keep a measurement or a check out for good. So
# everything goes in through a gate (~/.cache/threadbear-check/gate, which
# check-remote.sh's checks take too): a run waits there in line and holds it
# until it has its locks, and a run that has the host alone holds it
# throughout. A build lets it go once it's in, so the next build can join.
#
# THREADBEAR_PERF_LOCK_FIRST=1 (the app's update build, through remote.sh's
# THREADBEAR_REMOTE_FIRST) goes ahead of everything else waiting, as a
# landing's check does (scripts/host-turn.sh, which says how): it marks
# itself in ~/.cache/threadbear-check/first while it waits, and every other
# run lets such a mark go first, before the gate and again once it has it.
# Mike asked on 24 Nov, after the update build was put off 1,162 times in
# 1,350 tries behind agents' builds and his app ran half an hour to two
# hours behind main. --try with it still gives up on a busy host, but not
# for runs that are only queued: those go after it anyway.
use strict;
use warnings;
use Fcntl qw(:flock);
use Errno qw(EAGAIN EWOULDBLOCK EINTR);
use File::Path qw(make_path);
use FindBin;
use File::Spec;
use File::Temp qw(tempdir);
use IO::Select;
use POSIX qw(WNOHANG dup2);
use Sys::Hostname qw(hostname);
use Time::Local qw(timegm);

my ($desk, $try, $build) = (0, 0, 0);
while (@ARGV && ($ARGV[0] eq '--desk' || $ARGV[0] eq '--try' || $ARGV[0] eq '--build')) {
    my $arg = shift @ARGV;
    if ($arg eq '--desk') { $desk = 1; } elsif ($arg eq '--build') { $build = 1; } else { $try = 1; }
}
my $pidfile = shift(@ARGV) // die "perf-lock: missing pidfile or -\n";
@ARGV or die "perf-lock: missing command\n";
die "perf-lock: --desk needs a pidfile\n" if $desk && $pidfile eq '-';
die "perf-lock: --build is for plain builds, never a Desk Runner run\n" if $desk && $build;
$pidfile = File::Spec->rel2abs($pidfile) if $pidfile ne '-';
my $home = $ENV{HOME} // die "perf-lock: no HOME\n";
my $host = hostname();
my $owner = $ENV{THREADBEAR_PERF_LOCK_OWNER} // '';
# A marker only belongs to this host and home, and to a living lock holder.
# Desk Runner gets it explicitly below, since its service has its own env.
if ($owner =~ /^\Q$host\E:(\d+):\Q$home\E$/ && $1 > 0 && kill(0, $1)) {
    die "perf-lock: --desk starts a remote run; call its workload directly inside an existing run\n" if $desk;
    exec { $ARGV[0] } @ARGV or die "perf-lock: exec: $!\n";
}
# Inside a build that shares the host: another build can go on in it, but a
# measurement or a desk run can't, and waiting for the host alone would wait
# for itself for ever.
my $sharing = $ENV{THREADBEAR_PERF_LOCK_SHARED} // '';
if ($sharing =~ /^\Q$host\E:(\d+):\Q$home\E$/ && $1 > 0 && kill(0, $1)) {
    exec { $ARGV[0] } @ARGV or die "perf-lock: exec: $!\n" if $build;
    die "perf-lock: this is inside a build that shares $host with other builds (remote.sh --build), so a measurement or a Desk Runner run can't start here. Run it through remote.sh without --build.\n";
}
# How many builds may share this host; at 1 a build has it alone, as before.
my $lanes = 1;
if ($build && open(my $in, '<', "$home/.cache/threadbear-check/builds-at-once")) {
    my $n = <$in> // ''; close $in;
    $lanes = $1 if $n =~ /^\s*(\d+)\s*$/ && $1 >= 1;
    $lanes = 8 if $lanes > 8;
}
my $shared = $build && $lanes > 1;
my $first = ($ENV{THREADBEAR_PERF_LOCK_FIRST} // '') eq '1';
my $first_dir = "$home/.cache/threadbear-check/first";

my $cancelled = 0;
$SIG{TERM} = sub { $cancelled = 143 };
$SIG{HUP} = sub { $cancelled = 129 };
$SIG{INT} = sub { $cancelled = 130 };
# A dropped ssh can make even a diagnostic write fail. Cleanup must finish.
$SIG{PIPE} = 'IGNORE';
my $input = IO::Select->new(\*STDIN);
my $last_beat = 0;
sub keep_copy {
    return if time - $last_beat < 30;
    $last_beat = time;
    for my $name (qw(THREADBEAR_REMOTE_SOURCE THREADBEAR_REMOTE_TARGET THREADBEAR_REMOTE_TOOLS)) {
        my $dir = $ENV{$name} // next;
        next unless -d $dir;
        open(my $marker, '>>', "$dir/.in-use") or next;
        utime(undef, undef, "$dir/.in-use", $dir);
        close $marker;
    }
}
sub channel_gone {
    return 0 unless $input->can_read(0);
    my $n = sysread(STDIN, my $byte, 1);
    return defined($n) && $n == 0;
}
sub stopping {
    keep_copy();
    $cancelled ||= 129 if channel_gone();
    return $cancelled;
}

# Who holds the perf lock, for whoever is waiting. lsof can't say: every
# waiter has the file open too, and a waiter at 0% CPU looked like a holder
# that never started its run (14 Nov: a thread killed its own queued --desk
# run, three minutes after it had finally got the lock and started).
my $holder_file = "$home/.cache/threadbear-perf.lock.holder";
# A build sharing the host leaves its note beside it, one per build lane.
my $my_holder_file = $holder_file;
sub one_holder {
    my ($file) = @_;
    open(my $in, '<', $file) or return undef;
    my ($pid, $since, $label) = map { my $l = $_ // ''; chomp $l; $l } (<$in>)[0 .. 2];
    close $in;
    return 'whoever holds it left no note' unless ($pid // '') =~ /^\d+$/ && ($since // '') =~ /^\d+$/;
    my $mins = int((time - $since) / 60);
    my $alive = kill(0, $pid) ? '' : '; its run has ended and its cleanup is stopping what it left';
    return "held by perf-lock pid $pid for ${mins}m, running: $label$alive";
}
sub holder_text {
    my @notes = grep { defined } map { one_holder($_) } ($holder_file, sort glob("$holder_file.build-*"));
    return 'whoever holds it left no note (an older perf-lock.pl or lockf)' unless @notes;
    return join('; and ', @notes);
}
sub write_holder {
    my $label = $ENV{THREADBEAR_PERF_LOCK_LABEL} // join(' ', @ARGV);
    $label =~ s/\s+/ /g;
    $label = substr($label, 0, 157) . '...' if length($label) > 160;
    my $tmp = "$my_holder_file.$$";
    open(my $out, '>', $tmp) or return;
    print {$out} "$$\n", time, "\n$label\n";
    close $out;
    rename($tmp, $my_holder_file) or unlink($tmp);
}
my $wrote_holder = 0;
# And how many runs are queued ahead: one file per waiter, named by its pid,
# holding when it started waiting. Only a living pid counts.
my $main_pid = $$;
my $waiting_dir = "$holder_file" =~ s/\.holder$/.waiting/r;
my $waiting_since;
# The live waiters' notes: pid => [when it started waiting, came through the
# gate]. A note from a perf-lock.pl from before the gate (an older checkout's
# run) has no second line: it waits on the perf lock itself, where a build's
# shared lock would go in ahead of it.
sub live_waiters {
    my %live;
    opendir(my $dir, $waiting_dir) or return %live;
    my @pids = grep { /^\d+$/ && $_ > 0 && $_ != $$ && kill(0, $_) } readdir $dir;
    closedir $dir;
    for my $pid (@pids) {
        open(my $in, '<', "$waiting_dir/$pid") or next;
        my ($since, $gated) = (<$in>, <$in>); close $in;
        next unless defined($since) && $since =~ /^(\d+)\s*$/;
        $since = $1;
        # A killed waiter's note can outlast a reboot and pid reuse. A
        # process born after the note isn't its waiter. lstart works on both
        # macOS and Linux; use UTC and the C locale for one date format.
        local $ENV{LC_ALL} = 'C';
        local $ENV{TZ} = 'UTC';
        my $born = '';
        if (open(my $ps, '-|', 'ps', '-p', $pid, '-o', 'lstart=')) {
            $born = <$ps> // ''; close $ps;
        }
        if ($born =~ /^\s*\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)\s*$/) {
            my %month; @month{qw(Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec)} = (0 .. 11);
            my ($m, $d, $h, $min, $s, $y) = ($1, $2, $3, $4, $5, $6);
            my $at = eval { timegm($s, $min, $h, $d, $month{$m}, $y) };
            next if defined($at) && $at > $since;
        }
        # If ps couldn't say, leave the live waiter ahead rather than guess.
        next unless kill(0, $pid);
        $live{$pid} = [$since, defined($gated) && $gated =~ /^gate\s*$/ ? 1 : 0];
    }
    return %live;
}
# Whether a run that goes first is waiting (scripts/host-turn.sh): a mark in
# first/ that someone holds a lock on. One nobody holds (its run was killed)
# doesn't count; one with a dot in its name is a note, not a mark.
my $my_mark = "$first_dir/perf-$$";
sub first_waiting {
    opendir(my $dir, $first_dir) or return 0;
    my @names = grep { !/^\./ && !/\./ } readdir $dir;
    closedir $dir;
    for my $name (@names) {
        my $path = "$first_dir/$name";
        next if $path eq $my_mark;
        open(my $f, '<', $path) or next;
        my $got = flock($f, LOCK_EX | LOCK_NB);
        my $why = $!;
        close $f;
        return 1 if !$got && ($why == EAGAIN || $why == EWOULDBLOCK);
    }
    return 0;
}
# A run that goes first marks itself while it waits, until it has its locks.
my $mark_fh;
sub mark_first {
    return unless $first;
    make_path($first_dir);
    open($mark_fh, '>', $my_mark) or return;
    flock($mark_fh, LOCK_EX);
}
sub unmark_first {
    return unless $mark_fh;
    unlink($my_mark);
    close $mark_fh;
    undef $mark_fh;
}
# Everything else waits while one is waiting, before the gate.
sub let_first_go {
    return if $first;
    my $said = 0;
    while (first_waiting()) {
        exit $cancelled if stopping();
        if ($try) {
            print STDERR "Host has a landing's check or the app's update build waiting; deferring the update build.\n";
            exit 75;
        }
        print STDERR "Letting a landing's check or the app's update build go first on $host...\n" unless $said++;
        select(undef, undef, undef, 0.2);
    }
}
# Updaters never join the queue, and must not jump ahead of a waiter whose
# blocking locker hasn't been scheduled yet. Stale notes don't hold it up.
sub defer_to_waiters {
    return unless $try;
    return if $first;
    if (first_waiting()) {
        print STDERR "Host has a landing's check or the app's update build waiting; deferring the update build.\n";
        exit 75;
    }
    my %live = live_waiters();
    return unless %live;
    print STDERR "Host has queued work; deferring the update build.\n";
    exit 75;
}
sub start_waiting {
    make_path($waiting_dir);
    $waiting_since = time;
    open(my $out, '>', "$waiting_dir/$$") or return;
    print {$out} "$waiting_since\ngate\n";
    close $out;
}
sub stop_waiting { unlink("$waiting_dir/$main_pid") if defined $waiting_since; }
sub queued_ahead {
    return 0 unless defined $waiting_since && opendir(my $dir, $waiting_dir);
    my $ahead = 0;
    for my $pid (grep { /^\d+$/ && $_ != $$ } readdir $dir) {
        open(my $in, '<', "$waiting_dir/$pid") or next;
        my $since = <$in>; close $in;
        $ahead++ if defined($since) && $since =~ /^(\d+)$/ && $1 <= $waiting_since && kill(0, $pid);
    }
    closedir $dir;
    return $ahead;
}
sub queue_text {
    my $n = queued_ahead();
    return $n ? "; $n other run" . ($n == 1 ? '' : 's') . " waiting since before this one" : '';
}
END {
    # The locker and watcher forks run END too: only the supervisor tidies.
    stop_waiting() if $$ == $main_pid;
    unmark_first() if $$ == $main_pid;
    # Only our own note: a later holder may already have written its own.
    if ($$ == $main_pid && $wrote_holder && open(my $in, '<', $my_holder_file)) {
        my $pid = <$in>; close $in;
        unlink($my_holder_file) if defined($pid) && $pid =~ /^(\d+)$/ && $1 == $$;
    }
}

# Set while a run that doesn't go first waits for a lock with the gate held
# (the perf or check lock, for builds or a check to finish): it gives up its
# wait, and wait_for_lock says 0, when a run that goes first comes in, so the
# caller can give the gate back to it (Codex's review: with two builds at
# once, a check or measurement through the gate sat out a whole build ahead
# of a landing's check).
my $yield_to_first = 0;
sub wait_for_lock {
    my ($lock, $mode, $what, @held) = @_;
    pipe(my $ready_r, my $ready_w) or die "perf-lock: ready pipe: $!\n";
    pipe(my $live_r, my $live_w) or die "perf-lock: owner pipe: $!\n";
    my $locker = fork() // die "perf-lock: locker fork: $!\n";
    if (!$locker) {
        close $ready_r; close $live_r; close $live_w;
        $SIG{TERM} = $SIG{INT} = $SIG{HUP} = $SIG{PIPE} = 'DEFAULT';
        flock($lock, $mode) or die "perf-lock: blocking lock: $!\n";
        syswrite($ready_w, '1');
        exit 0;
    }
    close $ready_w;
    my $watcher = fork() // die "perf-lock: lock watcher fork: $!\n";
    if (!$watcher) {
        close $live_w;
        close $_ for ($lock, @held);
        # No lock fds in this watcher. If even KILL takes the owner while it
        # waits, stop its blocking locker; readiness also means it can leave.
        my $ready = IO::Select->new($ready_r);
        my $live = IO::Select->new($live_r);
        for (;;) {
            exit 0 if $ready->can_read(0);
            if ($live->can_read(0.1)) {
                kill 'TERM', $locker unless $ready->can_read(0);
                exit 0;
            }
        }
    }
    close $live_r;
    my $ready = IO::Select->new($ready_r);
    my $next_note = time + 300;
    my ($yielded, $next_look) = (0, 0);
    while (!$ready->can_read(0.1)) {
        last if stopping();
        if ($yield_to_first && !$first && time >= $next_look) {
            $next_look = time + 0.5;
            if (first_waiting()) { $yielded = 1; last; }
        }
        next unless $what && time >= $next_note;
        $next_note = time + 300;
        print STDERR "Still waiting for $what on $host: " . holder_text() . queue_text() . "\n";
    }
    if ($yielded && !$cancelled) {
        # Its locker may have got the lock just now; on the shared open file
        # it goes when the caller closes this one.
        kill 'TERM', $locker;
        waitpid($locker, 0);
        close $live_w;
        waitpid($watcher, 0);
        close $ready_r;
        return 0;
    }
    close $live_w if $cancelled;
    my $count = $cancelled ? 0 : sysread($ready_r, my $byte, 1);
    close $ready_r;
    waitpid($locker, 0);
    my $status = $?;
    close $live_w unless $cancelled;
    waitpid($watcher, 0);
    exit $cancelled if $cancelled;
    die "perf-lock: blocking locker failed\n" unless $count && $status == 0;
    # Got it just as one that goes first came in: that one still goes first,
    # and the lock goes as the caller drops it (Codex's second review).
    return 0 if $yield_to_first && !$first && first_waiting();
    return 1;
    # flock is on the shared open description, so this parent's fd keeps it
    # held when the locker exits. It never drops its place in the kernel queue.
}

make_path("$home/.cache/threadbear-check");
defer_to_waiters();
my $perf_lock = "$home/.cache/threadbear-perf.lock";
my $gate_lock = "$home/.cache/threadbear-check/gate";
# take(<path>, <mode>, <what>, <queue>, <held...>): the open, locked file.
# Keep the lock we actually acquired, including while waiting for the next
# one. A free probe followed by a build races a check starting after it.
# <queue> is the line runs wait in: a waiting note, and who's in the way.
# undef from a build lane that's busy, when asked not to wait (<mode> NB).
sub take {
    my ($path, $mode, $what, $queue, @held) = @_;
    my $said = 0;
    for (;;) {
        open(my $lock, '>>', $path) or die "perf-lock: $path: $!\n";
        my $locked = flock($lock, ($mode & ~LOCK_NB) | LOCK_NB);
        while (!$locked) {
            die "perf-lock: lock $path: $!\n" unless $! == EAGAIN || $! == EWOULDBLOCK || $! == EINTR;
            exit $cancelled if stopping();
            return undef if $mode & LOCK_NB;
            if ($try) {
                print STDERR "Host is busy ($what); deferring the update build.\n";
                exit 75;
            }
            start_waiting() if $queue && !defined $waiting_since;
            print STDERR "Waiting for $what on $host ($path)" . ($queue ? ', ' . holder_text() . queue_text() : '') . "...\n" unless $said++;
            wait_for_lock($lock, $mode, $queue ? $what : '', @held) or return undef;
            $locked = 1;
        }
        exit $cancelled if stopping();
        # Old lockf calls without -k unlink on exit. A waiter can then own a
        # deleted inode while a new caller owns its replacement. Reopen it.
        my @opened = stat($lock);
        my @named = stat($path);
        next unless @named && $opened[0] == $named[0] && $opened[1] == $named[1];
        return $lock;
    }
}
my @locks;
mark_first();
# The gate, after any run that goes first; and given back for one that came
# in while this waited for it, as two runs waiting on a lock are let in in
# no particular order.
sub take_gate {
    for (;;) {
        let_first_go();
        my $g = take($gate_lock, LOCK_EX, 'another build or measurement', 1);
        return $g if $first || !first_waiting();
        close $g;
    }
}
my $gate;
# take_or_yield: take(), but undef when a run that goes first came in while
# it waited (yield_to_first, above).
sub take_or_yield {
    $yield_to_first = 1;
    my $l = take(@_);
    $yield_to_first = 0;
    return $l;
}
ACQUIRE: for (;;) {
@locks = ();
$gate = take_gate();
if ($shared) {
    # A lane of its own: the first that's free, waiting in line for one
    # (holding the gate, so it's next) by looking again every fifth of a
    # second, as no one flock waits for whichever of several frees first.
    my ($lane, $said, $next_note) = (undef, 0, time + 300);
    for (;;) {
        for my $n (1 .. $lanes) {
            $lane = take("$perf_lock.build-$n", LOCK_EX | LOCK_NB, '', 0, $gate) and do { $my_holder_file = "$holder_file.build-$n"; last };
        }
        last if $lane;
        exit $cancelled if stopping();
        # Waiting for a lane with the gate held: one that goes first, come in
        # meanwhile, takes the gate before this.
        if (!$first && first_waiting()) {
            close $gate;
            $gate = take_gate();
            next;
        }
        if ($try) {
            print STDERR "Host is busy (its $lanes builds at once); deferring the update build.\n";
            exit 75;
        }
        start_waiting() unless defined $waiting_since;
        my $what = "one of the $lanes builds this host runs at once";
        print STDERR "Waiting for $what on $host, " . holder_text() . queue_text() . "...\n" unless $said++;
        if (time >= $next_note) {
            $next_note = time + 300;
            print STDERR "Still waiting for $what on $host: " . holder_text() . queue_text() . "\n";
        }
        select(undef, undef, undef, 0.2);
    }
    push @locks, $lane;
    # An older perf-lock.pl's measurement waiting for the perf lock alone
    # never meets the gate, and macOS would let this build's shared lock in
    # ahead of it, every time. Until those are gone, it goes first.
    ($said, $next_note) = (0, time + 300);
    while (grep { !$_->[1] } values %{{ live_waiters() }}) {
        exit $cancelled if stopping();
        if ($try) {
            print STDERR "Host has queued work; deferring the update build.\n";
            exit 75;
        }
        print STDERR "Letting a measurement from an older checkout go first on $host...\n" unless $said++;
        select(undef, undef, undef, 0.2);
    }
    for my $want ([$perf_lock, 'a measurement or Desk Runner run', 1], ["$home/.cache/threadbear-check/lock", 'a check', 0]) {
        my $l = take_or_yield($want->[0], LOCK_SH, $want->[1], $want->[2], $gate, @locks);
        unless ($l) { close $_ for @locks, $gate; next ACQUIRE; }
        push @locks, $l;
    }
    # In: the next build can come through the gate and join.
    close $gate;
} else {
    push @locks, $gate;
    for my $want ([$perf_lock, 'another build or measurement', 1], ["$home/.cache/threadbear-check/lock", 'another check', 0]) {
        my $l = take_or_yield($want->[0], LOCK_EX, $want->[1], $want->[2], @locks);
        unless ($l) { close $_ for @locks; next ACQUIRE; }
        push @locks, $l;
    }
}
last;
}
stop_waiting(); unmark_first(); write_holder(); $wrote_holder = 1;
defer_to_waiters();
# Only a run that has the host alone can have a measurement nested in it.
if ($shared) { $ENV{THREADBEAR_PERF_LOCK_SHARED} = "$host:$$:$home"; delete $ENV{THREADBEAR_PERF_LOCK_OWNER}; }
else { $ENV{THREADBEAR_PERF_LOCK_OWNER} = "$host:$$:$home"; }
my $registry = tempdir('perf-children-XXXXXXXX', DIR => "$home/.cache/threadbear-check");
open(my $registry_state, '>', "$registry/state") or die "perf-lock: registry: $!\n";
close $registry_state;
$ENV{THREADBEAR_PERF_CHILDREN} = $registry;

my @command = @ARGV;
if ($desk) {
    die "perf-lock: --desk needs a fresh pidfile\n" if $pidfile eq '-' || -e $pidfile || -e "$pidfile.gone";
    my $quote = sub { my $s = shift; $s =~ s/'/'\\''/g; return "'$s'"; };
    # The desk line's first step, run by Desk Runner. It leaves Desk Runner's
    # process group (perf-children.pl --child must lead its own), so Desk
    # Runner's cancel can't reach it, and the hangup guard finds it only by
    # the pid it writes to <pidfile>. Every step after it execs, keeping the pid.
    #
    # Before that it opens what the run needs (this script's folder, the
    # pidfile's, the build folders), each in a child killed after <seconds>.
    # On Tinker Desk those are on an external SSD, and macOS holds a Desk
    # Runner process's open() there until someone allows it "Removable
    # Volumes", with nobody at the screen to ask: from 17 Nov every --desk run
    # sat in perl --child, not having read its own script, and outlived its
    # ssh, as the pid was only written later, by the bash below. The pidfile
    # is on that disk too (Codex's review), so it's written only after the
    # check, which ends by itself either way; a run whose ssh went meanwhile
    # finds <pidfile>.gone and stops there.
    # perl -e <this> <pidfile> <seconds> <n> <path>... <command...>
    my $desk_start = <<'START';
setpgrp(0, 0);
use Time::HiRes qw(clock_gettime CLOCK_MONOTONIC);
my ($pidfile, $wait, $n) = splice(@ARGV, 0, 3);
sub refuse {
    print STDERR "perf-lock: Desk Runner $_[0], so this run can't start. macOS may be holding it for a privacy "
        . "permission it can't ask anyone for: on this host, allow Desk Runner in System Settings > "
        . "Privacy & Security > Files & Folders (Removable Volumes), or give it Full Disk Access. An agent does this "
        . "itself without asking (Mike, 19 Nov): docs/dev-tools.md, \"Dev runner and one check command\".\n";
    exit 126;
}
for my $path (splice(@ARGV, 0, $n)) {
    pipe(my $why_r, my $why_w) or exit 126;
    my $pid = fork() // exit 126;
    if (!$pid) {
        close $why_r;
        my $ok = -d $path ? opendir(my $d, $path) : open(my $f, '<', $path);
        print {$why_w} "$!" unless $ok;
        exit($ok ? 0 : 2);
    }
    close $why_w;
    # Monotonic, so a clock stepped back mid-wait can't stretch it.
    my $end = clock_gettime(CLOCK_MONOTONIC) + $wait;
    my $done = 0;
    until (($done = waitpid($pid, 1) == $pid) || clock_gettime(CLOCK_MONOTONIC) >= $end) { select(undef, undef, undef, 0.1); }
    if (!$done && waitpid($pid, 1) != $pid) {
        kill 'KILL', $pid; waitpid($pid, 0);
        refuse("couldn't open $path within ${wait}s");
    }
    next if $? == 0;
    my $why = do { local $/; <$why_r> } // '';
    refuse("couldn't open $path" . (length $why ? " ($why)" : ''));
}
open(my $f, '>', $pidfile) or exit 129;
print {$f} "$$\n";
close $f or exit 129;
# Gone already: the guard writes .gone before it reads the pidfile, so it
# may have this pid and be about to stop it (TERM, then KILL 5 s on). Hold
# the pid till then, so its signals can't reach whatever gets it next.
if (-e "$pidfile.gone") { truncate($pidfile, 0); sleep 30; exit 129; }
exec { $ARGV[0] } @ARGV or exit 127;
START
    my @reads = grep { -e $_ } ("$FindBin::Bin/perf-children.pl", $pidfile =~ s{/[^/]*$}{}r,
        "$home/.cache/threadbear-check/gpui", map { $ENV{$_} // () } qw(THREADBEAR_REMOTE_SOURCE THREADBEAR_REMOTE_TARGET));
    my $line = join(' ', map { $quote->($_) }
        ('env', "THREADBEAR_PERF_LOCK_OWNER=$ENV{THREADBEAR_PERF_LOCK_OWNER}",
         "THREADBEAR_PERF_CHILDREN=$registry",
         'perl', '-e', $desk_start, $pidfile, $ENV{THREADBEAR_DESK_READ_SECONDS} || 20, scalar(@reads), @reads,
         'perl', "$FindBin::Bin/perf-children.pl", '--child', $registry, '/bin/bash', '-c',
         'echo $$ >"$1"; [ ! -e "$1.gone" ] || exit 129; shift; exec "$@"',
         'perf-desk', $pidfile, @command));
    @command = ("$home/.local/bin/desk", $line);
}
# The guard gets a pipe of its own. Only this supervisor writes it; closing it
# on TERM or ssh EOF asks the guard to clean up while we keep both locks.
pipe(my $read, my $write) or die "perf-lock: pipe: $!\n";
my $child = fork() // die "perf-lock: fork: $!\n";
if (!$child) {
    # A terminal/group cancellation must reach this supervisor, whose pipe
    # then asks the guard to clean up. It mustn't kill the guard and watcher.
    setpgrp(0, 0);
    $SIG{PIPE} = 'DEFAULT';
    close $write;
    # The guard keeps copies too: even KILL of this supervisor must leave the
    # locks held while EOF makes the guard stop its command. Use high fds,
    # since the guard uses fd 3 for its channel. dup2 clears close-on-exec.
    for my $i (0 .. $#locks) {
        dup2(fileno($locks[$i]), 198 + $i) >= 0 or die "perf-lock: dup: $!\n";
    }
    close $_ for @locks;
    open(STDIN, '<&', $read) or die "perf-lock: stdin: $!\n";
    close $read;
    # The guard holds the copies, its workload doesn't. A successful run can
    # leave a harmless heartbeat sleeping briefly; it mustn't keep the turn.
    exec 'perl', "$FindBin::Bin/perf-children.pl", '--reap', $registry, $pidfile,
        '/bin/bash', '-c', 'exec 198>&- 199>&- 200>&-; exec "$@"', 'perf-command',
        'perl', "$FindBin::Bin/perf-children.pl", '--child', $registry, @command;
    die "perf-lock: guard: $!\n";
}
close $read;
my $closed = 0;
for (;;) {
    my $done = waitpid($child, WNOHANG);
    if ($done == $child) {
        my $status = $?;
        close $write unless $closed;
        exit($cancelled || ($status & 127 ? 128 + ($status & 127) : $status >> 8));
    }
    if (stopping() && !$closed) { close $write; $closed = 1; }
    select(undef, undef, undef, 0.1);
}
