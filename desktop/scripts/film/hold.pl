#!/usr/bin/perl
# Holds the host's build-and-measurement lock (scripts/perf-lock.pl's
# ~/.cache/threadbear-perf.lock) for a filming session, so the stage never
# swaps the screen under another thread's --desk run and theirs never starts
# mid-take. Waiters see "film.sh" as who holds it.
#
#   perl hold.pl <dir> <stage binary> <WxH>
#
# Once it has the lock it writes <dir>/locked, waits for film.sh to write the
# app's pid to <dir>/go, runs the stage for that app (a child, so it keeps
# Desk Runner's Accessibility) and lets the lock go when the stage ends. It
# gives up without a stage on <dir>/stage.stop or after 10 minutes with no go.
use strict;
use warnings;
use Fcntl qw(:flock);

my ($dir, $stage, $size) = @ARGV;
die "usage: hold.pl <dir> <stage> <WxH>\n" unless $size;
my $home = $ENV{HOME} or die "no HOME\n";
my $file = "$home/.cache/threadbear-perf.lock";
mkdir "$home/.cache";
open(my $lock, '>>', $file) or die "hold: $file: $!\n";
flock($lock, LOCK_EX) or die "hold: lock: $!\n";
# The note perf-lock.pl shows whoever is waiting: pid, since, what.
my $holder = "$file.holder";
if (open(my $out, '>', "$holder.$$")) {
    print $out "$$\n" . time() . "\nfilm.sh: filming the GPUI app on its 2x stage (desktop/scripts/film.sh stop ends it)\n";
    close $out;
    rename "$holder.$$", $holder;
}
if (open(my $marker, '>', "$dir/locked")) { close $marker; }
my $pid;
for (1 .. 3000) {
    last if -e "$dir/stage.stop";
    if (open(my $in, '<', "$dir/go")) { ($pid) = <$in> =~ /(\d+)/; close $in; last if $pid; }
    select(undef, undef, undef, 0.2);
}
system($stage, $pid, $dir, $size) if $pid;
# The note goes with the lock if it's still ours.
if (open(my $in, '<', $holder)) {
    my $who = <$in> // '';
    close $in;
    unlink $holder if $who =~ /^$$\b/;
}
unlink "$dir/locked", "$dir/go";
