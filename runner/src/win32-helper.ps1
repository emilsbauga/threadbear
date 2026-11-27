# The runner's helper on Windows (src/win32-helper.ts starts it, hidden, and
# keeps it running). What ps and lsof tell the runner on a Mac, Windows
# only tells through PowerShell, and a new powershell.exe for each question
# takes a second or more; this one answers in about a tenth of that.
#
# One request a line on stdin, as JSON: { "id": n, "op": ..., ... }. One
# answer a line on stdout: { "id": n, "ok": true, "result": "<text>" } or
# { "id": n, "ok": false, "error": "<why>" }. Results are plain text the
# runner parses, so PowerShell 5's JSON quirks (a one-item array coming out
# as the item) can't change their shape.
#
#   processes   every process, one "pid ppid created" line each, created
#               as a FILETIME (100 ns since 1601, UTC; 0 when Windows
#               won't say)
#   jobAssign   put pid (a CLI just started) in a new job called name, and
#               answer when that process started (a FILETIME)
#   jobForget   let go of the job called name without ending it
#   jobEnd      end every process still in the job called name: 'ended',
#               or 'missing' when no job has that name any more
#   privateDir  make the folder at path this user's and SYSTEM's only,
#               and answer this user's SID
#   snapshot    for port: every established connection to it, with the
#               pid holding the client's end, and every process (below),
#               in one answer, so any number of connections waiting to be
#               looked up share one (peer.ts)
#   environ     for pids (comma-separated): each process's environment
#               block, one line each: "e pid <base64 of the UTF-16 block>",
#               "x pid" when Windows won't let this user read it (another
#               user's, an elevated or protected process), or "g pid" when
#               it has gone (peer.ts, Daybreak finding 177)
#   jobsOf      for pids (comma-separated): the Threadbear jobs each is in,
#               of every runner of this user in this session (named
#               Local\threadbear-job-*, found in the session's object
#               directory), one line each: "j pid name,name..." ("j pid"
#               for none), "x pid" when it can't be opened, "g pid" when it
#               has gone. A thread's CLI and everything it starts are in its
#               job and can't leave, whatever their parents (Git Bash's
#               processes lose theirs at each exec)
#   idle        milliseconds since the last keyboard or mouse input in this
#               session (presence.ts)
#   awake       on = 1: keep the computer from sleeping by itself while this
#               helper runs; on = 0: let it again (keep-awake.ts)
#   power       "<on battery 0|1> <percent, or -1 when unknown>"
#
# The runner doesn't run this file: it reads it once when it starts and
# sends it whole as the helper's first line, to a two-line loader passed as
# -EncodedCommand (win32-helper.ts), so changing the file under a running
# runner changes nothing (Codex's review, 18 Nov 2026). The script itself
# grew past what a command line holds (ENAMETOOLONG, 18 Nov).
# Variables here mustn't be reused as a loop's: PowerShell keeps a loop
# variable's last value ($sid once held a type, Codex's fourth review).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Only Windows' own modules, from System32 by full path, and nothing loaded
# by name from anywhere else: PowerShell would otherwise find a module
# called NetTCPIP or CimCmdlets in Documents\WindowsPowerShell\Modules first,
# and a thread can write there (Codex's third review, 18 Nov 2026). The
# commands below are called by their modules' names too.
$PSModuleAutoLoadingPreference = 'None'
$system = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
$env:PSModulePath = $system
foreach ($m in 'Microsoft.PowerShell.Utility', 'CimCmdlets', 'NetTCPIP') {
  Import-Module "$system\$m" -ErrorAction Stop
}
# Job Objects (jobAssign, jobEnd), through kernel32 declared in memory:
# Add-Type would compile C# to files in %TEMP%, which a thread can write.
$asm = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'ThreadbearNative'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $asm.DefineDynamicModule('ThreadbearNative').DefineType('ThreadbearNative.Kernel32', 'Public, Class')
$importCtor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([string])
$lastError = [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError')
# The attribute's CharSet too: left out, it said Ansi over the method's
# Unicode, so job names reached CreateJobObjectW as ANSI bytes read as
# UTF-16 (and read on past their end: Gemini's review of finding 177).
$charSet = [Runtime.InteropServices.DllImportAttribute].GetField('CharSet')
function Declare($name, $ret, [Type[]]$params, $dll = 'kernel32.dll') {
  $m = $type.DefinePInvokeMethod($name, $dll, [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $ret, $params, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $m.SetImplementationFlags('PreserveSig')
  $m.SetCustomAttribute((New-Object Reflection.Emit.CustomAttributeBuilder($importCtor, @($dll), [Reflection.FieldInfo[]]@($lastError, $charSet), [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode))))
}
Declare 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [string])
Declare 'OpenJobObjectW' ([IntPtr]) @([UInt32], [bool], [string])
Declare 'OpenProcess' ([IntPtr]) @([UInt32], [bool], [UInt32])
Declare 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
Declare 'TerminateJobObject' ([bool]) @([IntPtr], [UInt32])
Declare 'CloseHandle' ([bool]) @([IntPtr])
# environ: a process's environment, from its PEB, as a debugger reads it.
Declare 'ReadProcessMemory' ([bool]) @([IntPtr], [IntPtr], [byte[]], [IntPtr], [IntPtr])
Declare 'NtQueryInformationProcess' ([int]) @([IntPtr], [int], [byte[]], [int], [IntPtr]) 'ntdll.dll'
# jobsOf: the session's named objects, and whether a process is in a job.
Declare 'NtOpenDirectoryObject' ([int]) @([IntPtr].MakeByRefType(), [UInt32], [IntPtr]) 'ntdll.dll'
Declare 'NtQueryDirectoryObject' ([int]) @([IntPtr], [IntPtr], [UInt32], [bool], [bool], [UInt32].MakeByRefType(), [IntPtr]) 'ntdll.dll'
Declare 'NtClose' ([int]) @([IntPtr]) 'ntdll.dll'
Declare 'NtOpenJobObject' ([int]) @([IntPtr].MakeByRefType(), [UInt32], [IntPtr]) 'ntdll.dll'
Declare 'DuplicateHandle' ([bool]) @([IntPtr], [IntPtr], [IntPtr], [IntPtr].MakeByRefType(), [UInt32], [bool], [UInt32])
Declare 'GetCurrentProcess' ([IntPtr]) @()
Declare 'SetInformationJobObject' ([bool]) @([IntPtr], [int], [byte[]], [UInt32])
Declare 'ProcessIdToSessionId' ([bool]) @([UInt32], [UInt32].MakeByRefType())
Declare 'IsProcessInJob' ([bool]) @([IntPtr], [IntPtr], [bool].MakeByRefType())
$long = [long].MakeByRefType()
Declare 'GetProcessTimes' ([bool]) @([IntPtr], $long, $long, $long, $long)
# idle, awake and power. LASTINPUTINFO and SYSTEM_POWER_STATUS are passed
# as byte arrays, which are pinned, so what Windows writes is seen.
Declare 'GetLastInputInfo' ([bool]) @([byte[]]) 'user32.dll'
Declare 'GetTickCount' ([UInt32]) @()
Declare 'SetThreadExecutionState' ([UInt32]) @([UInt32])
Declare 'GetSystemPowerStatus' ([bool]) @([byte[]])
$K = $type.CreateType()
function LastError { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
# The job of each CLI this helper has put in one, by name. A helper started
# again later opens one by its name instead.
$jobs = @{}

# jobsOf: every Threadbear job named in one object directory, opened
# (JOB_OBJECT_QUERY) from the listing, by its name without "Local\".
function JobsIn($dirName) {
  # Each job is opened from the listing itself (NtOpenJobObject on the
  # directory handle and the name as listed), not by a name passed back
  # through a string. A helper from before the Declare CharSet fix made its
  # jobs with ANSI bytes read as UTF-16 for a name; those are read that way
  # too.
  $open = @{}
  $nameBuf = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($dirName)
  $us = [Runtime.InteropServices.Marshal]::AllocHGlobal(16)
  $oa = [Runtime.InteropServices.Marshal]::AllocHGlobal(48)
  $joa = [Runtime.InteropServices.Marshal]::AllocHGlobal(48)
  # Big enough for any one entry (a name is at most 64 KiB).
  $bufSize = 1048576
  $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($bufSize)
  $dir = [IntPtr]::Zero
  try {
    # UNICODE_STRING { Length, MaximumLength, Buffer } and
    # OBJECT_ATTRIBUTES { Length, RootDirectory, ObjectName,
    # Attributes, SecurityDescriptor, SecurityQualityOfService }.
    for ($i = 0; $i -lt 48; $i += 8) {
      [Runtime.InteropServices.Marshal]::WriteInt64($oa, $i, 0)
      [Runtime.InteropServices.Marshal]::WriteInt64($joa, $i, 0)
    }
    [Runtime.InteropServices.Marshal]::WriteInt16($us, 0, [int16]($dirName.Length * 2))
    [Runtime.InteropServices.Marshal]::WriteInt16($us, 2, [int16]($dirName.Length * 2 + 2))
    [Runtime.InteropServices.Marshal]::WriteInt32($us, 4, 0)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($us, 8, $nameBuf)
    [Runtime.InteropServices.Marshal]::WriteInt32($oa, 0, 48)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($oa, 16, $us)
    # OBJ_CASE_INSENSITIVE
    [Runtime.InteropServices.Marshal]::WriteInt32($oa, 24, 0x40)
    # DIRECTORY_QUERY | DIRECTORY_TRAVERSE
    $status = $K::NtOpenDirectoryObject([ref]$dir, 3, $oa)
    if ($status -ne 0) { throw "NtOpenDirectoryObject $dirName failed ($status)" }
    [Runtime.InteropServices.Marshal]::WriteInt32($joa, 0, 48)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($joa, 8, $dir)
    # The whole directory in one call, which the kernel fills under its
    # lock: read a page at a time, an object removed between pages could
    # make the next page skip one (Gemini's review). Too small a buffer
    # (0x105, more entries; 0xC0000023, too small) is grown and the read
    # started again; past 64 MiB it's no answer.
    while ($true) {
      $context = [UInt32]0
      $status = $K::NtQueryDirectoryObject($dir, $buf, $bufSize, $false, $true, [ref]$context, [IntPtr]::Zero)
      if ($status -ne 0x105 -and $status -ne -1073741789) { break }
      if ($bufSize -ge 67108864) { throw 'the object directory is too big to read in one go' }
      [Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
      $buf = [IntPtr]::Zero
      $bufSize *= 4
      $buf = [Runtime.InteropServices.Marshal]::AllocHGlobal($bufSize)
    }
    # OBJECT_DIRECTORY_INFORMATION { UNICODE_STRING Name, UNICODE_STRING
    # TypeName } entries, a zeroed one last. 0x8000001A: an empty directory.
    if ($status -ne 0 -and $status -ne -2147483622) { throw "NtQueryDirectoryObject failed ($status)" }
    if ($status -eq 0) {
      for ($at = 0; ; $at += 32) {
        $namePtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($buf, $at + 8)
        if ($namePtr -eq [IntPtr]::Zero) { break }
        # Lengths are unsigned (USHORT).
        $typeLen = [Runtime.InteropServices.Marshal]::ReadInt16($buf, $at + 16) -band 0xFFFF
        $objType = [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($buf, $at + 24), $typeLen / 2)
        if ($objType -ne 'Job') { continue }
        $nameLen = [Runtime.InteropServices.Marshal]::ReadInt16($buf, $at) -band 0xFFFF
        $raw = New-Object byte[] $nameLen
        [Runtime.InteropServices.Marshal]::Copy($namePtr, $raw, 0, $nameLen)
        # As made now (UTF-16), or by a helper from before the CharSet fix
        # (ANSI bytes read as UTF-16, perhaps with more after their NUL).
        $canonical = $null
        $wide = [Text.Encoding]::Unicode.GetString($raw)
        $narrow = [Text.Encoding]::ASCII.GetString($raw).Split([char]0)[0]
        # \z, not $: $ also matches before a final line break, and a name
        # with one is another object (Gemini's review).
        if ($wide -cmatch '\Athreadbear-job-[0-9a-f]{32}\z') { $canonical = $wide }
        elseif ($narrow -cmatch '\ALocal\\(threadbear-job-[0-9a-f]{32})\z') { $canonical = $Matches[1] }
        if (-not $canonical) { continue }
        # Opened by the listed name, relative to the directory. Every object
        # that reads as the same job is kept: one made to look like it can't
        # hide the real one (Codex's and Gemini's reviews).
        [Runtime.InteropServices.Marshal]::WriteIntPtr($joa, 16, [IntPtr]($buf.ToInt64() + $at))
        $job = [IntPtr]::Zero
        # JOB_OBJECT_QUERY. One gone since the listing (0xC0000034, not
        # found) isn't one any process is in; any other failure is no answer.
        $opened = $K::NtOpenJobObject([ref]$job, 0x0004, $joa)
        if ($opened -eq 0) {
          if (-not $open.ContainsKey($canonical)) { $open[$canonical] = New-Object System.Collections.Generic.List[IntPtr] }
          $open[$canonical].Add($job)
        } elseif ($opened -ne -1073741772) { throw "NtOpenJobObject failed ($opened)" }
      }
    }
  } catch {
    foreach ($list in $open.Values) { foreach ($h in $list) { [void]$K::CloseHandle($h) } }
    throw
  } finally {
    if ($dir -ne [IntPtr]::Zero) { [void]$K::NtClose($dir) }
    if ($buf -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buf) }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($joa)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($oa)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($us)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($nameBuf)
  }
  return $open
}

[Console]::OutputEncoding = [Text.Encoding]::UTF8
$in = [Console]::In
$out = [Console]::Out

while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  $id = $null
  try {
    $req = $line | Microsoft.PowerShell.Utility\ConvertFrom-Json
    $id = $req.id
    switch ($req.op) {
      'ping' { $result = 'pong' }
      'processes' {
        $rows = CimCmdlets\Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object {
          $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
          "$($_.ProcessId) $($_.ParentProcessId) $created"
        }
        $result = ($rows -join "`n")
      }
      'snapshot' {
        # Each established connection to the port, as its client sees it
        # ("c localAddress localPort remoteAddress remotePort pid"), then
        # every process ("p pid ppid created"). Taken after the connections,
        # so a process holding one is in the list.
        # None found is an error of its own kind (ObjectNotFound), and the
        # only one that means none: any other (access denied, the provider
        # failing) fails the snapshot, so it can't pass for "nobody's".
        try {
          $found = @(NetTCPIP\Get-NetTCPConnection -State Established -RemotePort ([int]$req.port) -ErrorAction Stop)
        } catch {
          if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw }
          $found = @()
        }
        $conns = $found | Where-Object { $_ } | ForEach-Object {
          "c $($_.LocalAddress) $($_.LocalPort) $($_.RemoteAddress) $($_.RemotePort) $($_.OwningProcess)"
        }
        $procs = CimCmdlets\Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate | ForEach-Object {
          $created = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }
          "p $($_.ProcessId) $($_.ParentProcessId) $created"
        }
        $result = ((@($conns) + @($procs)) -join "`n")
      }
      'jobAssign' {
        # A job of its own for a CLI the runner has just started (it holds
        # the child's handle, so the pid is still that CLI's), named by the
        # runner with a random part. Everything the CLI starts from then on
        # is in it too, and can't leave.
        if ([IntPtr]::Size -ne 8) { throw 'the helper is a 32-bit process' }
        $name = [string]$req.name
        if ($name -notmatch '^Local\\threadbear-job-[0-9a-f]{32}$') { throw "not a job name: $name" }
        # Not one that's there already (someone else's): looked for first, as
        # PowerShell's own calls can overwrite the error code checked below.
        $there = $K::OpenJobObjectW(0x0008, $false, $name)
        if ($there -ne [IntPtr]::Zero) { [void]$K::CloseHandle($there); throw 'a job by that name already exists' }
        $job = $K::CreateJobObjectW([IntPtr]::Zero, $name)
        $err = LastError
        if ($job -eq [IntPtr]::Zero) { throw "CreateJobObject failed ($err)" }
        # 183: there's already one by that name, which isn't ours to use.
        if ($err -eq 183) { [void]$K::CloseHandle($job); throw 'a job by that name already exists' }
        # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: once its last handle has gone
        # (this helper's, and the CLI's own below), whatever is still in it
        # ends, so nothing of a thread's is left running in a job that has
        # lost its name (Codex's second review). JOBOBJECT_EXTENDED_LIMIT_
        # INFORMATION (class 9) is 144 bytes; LimitFlags is at 16.
        $limits = New-Object byte[] 144
        [BitConverter]::GetBytes([UInt32]0x2000).CopyTo($limits, 16)
        if (-not $K::SetInformationJobObject($job, 9, $limits, 144)) { $err = LastError; [void]$K::CloseHandle($job); throw "SetInformationJobObject failed ($err)" }
        # PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_DUP_HANDLE |
        # PROCESS_QUERY_LIMITED_INFORMATION
        $proc = $K::OpenProcess(0x1141, $false, [UInt32]$req.pid)
        if ($proc -eq [IntPtr]::Zero) { $err = LastError; [void]$K::CloseHandle($job); throw "OpenProcess failed ($err)" }
        # When it started, read before it goes in: one that started after
        # notAfter got the CLI's pid after the CLI went, and is left alone
        # (once in a job, a process can't be taken out of it).
        $created = [long]0; $exit = [long]0; $kernel = [long]0; $user = [long]0
        $timed = $K::GetProcessTimes($proc, [ref]$created, [ref]$exit, [ref]$kernel, [ref]$user)
        if (-not $timed -or $created -gt [long]$req.notAfter) {
          [void]$K::CloseHandle($proc); [void]$K::CloseHandle($job)
          throw "process $($req.pid) isn't the one the runner started"
        }
        $ok = $K::AssignProcessToJobObject($job, $proc)
        $err = LastError
        if (-not $ok) { [void]$K::CloseHandle($proc); [void]$K::CloseHandle($job); throw "AssignProcessToJobObject failed ($err)" }
        # A handle to its job in the CLI itself (JOB_OBJECT_QUERY only), so
        # the job keeps its name while the CLI lives, whatever becomes of
        # this helper: a job's name goes with its last handle, and jobsOf
        # finds a thread's job by its name (Daybreak finding 177's reviews).
        $kept = [IntPtr]::Zero
        $dup = $K::DuplicateHandle($K::GetCurrentProcess(), $job, $proc, [ref]$kept, 0x0004, $false, 0)
        $err = LastError
        [void]$K::CloseHandle($proc)
        if (-not $dup) { [void]$K::CloseHandle($job); throw "DuplicateHandle failed ($err)" }
        # What it started before it went in (a launcher's real CLI, an MCP
        # server: Node can't start a process suspended) goes in too: every
        # descendant of it, by parent and started no earlier than its
        # parent, until a look finds none outside (Codex's third review).
        # One that can't be put in fails the job, and the runner stops the
        # CLI and all it started (proc.ts killUnjobbed).
        $settled = $false
        try {
        for ($sweep = 0; $sweep -lt 5; $sweep++) {
          $rows = @{}
          foreach ($r in (CimCmdlets\Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)) {
            $rows[[UInt32]$r.ProcessId] = @{ ppid = [UInt32]$r.ParentProcessId; created = $(if ($r.CreationDate) { $r.CreationDate.ToFileTimeUtc() } else { 0 }) }
          }
          $found = New-Object System.Collections.Generic.List[UInt32]
          $frontier = @([UInt32]$req.pid)
          while ($frontier.Count) {
            $next = @()
            foreach ($pp in $frontier) {
              foreach ($cp in $rows.Keys) {
                $c = $rows[$cp]
                if ($c.ppid -eq $pp -and $cp -ne $pp -and -not $found.Contains($cp) -and ($pp -ne [UInt32]$req.pid -or $c.created -ge $created - 10) -and ($pp -eq [UInt32]$req.pid -or $c.created -ge $rows[$pp].created)) { $found.Add($cp); $next += $cp }
              }
            }
            $frontier = $next
          }
          $added = 0
          foreach ($cp in $found) {
            $child = $K::OpenProcess(0x1101, $false, $cp)
            if ($child -eq [IntPtr]::Zero) {
              # 87: gone since the look.
              if ((LastError) -eq 87) { continue }
              throw "OpenProcess $cp failed"
            }
            try {
              # The same process the look saw, not one that got its pid
              # since (Codex's and Gemini's reviews): else it's left alone.
              $cc = [long]0; $ce = [long]0; $ck = [long]0; $cu = [long]0
              # (WMI gives a start to the microsecond, 10 of these ticks.)
              if (-not $K::GetProcessTimes($child, [ref]$cc, [ref]$ce, [ref]$ck, [ref]$cu) -or [Math]::Abs($cc - [long]$rows[$cp].created) -ge 10) { continue }
              $already = $false
              if (-not $K::IsProcessInJob($child, $job, [ref]$already)) { throw "IsProcessInJob $cp failed" }
              if (-not $already) {
                if (-not $K::AssignProcessToJobObject($job, $child)) { throw "AssignProcessToJobObject $cp failed ($(LastError))" }
                $added++
              }
            } finally {
              [void]$K::CloseHandle($child)
            }
          }
          if ($added -eq 0) { $settled = $true; break }
        }
        # Still finding some on the last look: no answer, rather than leave
        # one outside.
        if (-not $settled) { throw 'its processes were still starting others' }
        } catch {
          [void]$K::CloseHandle($job)
          throw
        }
        $jobs[$name] = $job
        $result = if ($timed) { [string]$created } else { '0' }
      }
      'jobEnd' {
        # Ends every process still in the CLI's job. One this helper didn't
        # make and can't open by name is 'missing', not ended: a job's name
        # goes with its last handle (this helper's and the CLI's own, from
        # jobAssign), and one made since KILL_ON_JOB_CLOSE ended its
        # processes as it went. The runner falls back to their pids then
        # (proc.ts endJob).
        $name = [string]$req.name
        if ($name -notmatch '^Local\\threadbear-job-[0-9a-f]{32}$') { throw "not a job name: $name" }
        $job = $jobs[$name]
        $jobs.Remove($name)
        # JOB_OBJECT_TERMINATE
        if (-not $job) { $job = $K::OpenJobObjectW(0x0008, $false, $name) }
        if ($job -eq [IntPtr]::Zero -or -not $job) { $result = 'missing' } else {
          $ok = $K::TerminateJobObject($job, 1)
          $err = LastError
          [void]$K::CloseHandle($job)
          if (-not $ok) { throw "TerminateJobObject failed ($err)" }
          $result = 'ended'
        }
      }
      'jobForget' {
        # Lets go of a job without ending it (one that got a process that
        # wasn't the CLI).
        $name = [string]$req.name
        $job = $jobs[$name]
        $jobs.Remove($name)
        if ($job) { [void]$K::CloseHandle($job) }
        $result = 'ok'
      }
      'privateDir' {
        # The secrets folder made this user's and SYSTEM's only (win-acl.ts):
        # its access list replaced whole, inheriting nothing, so no grant
        # anyone added before survives; everything already in it made to
        # take only what the folder passes on; then read back to check.
        $dir = New-Object IO.DirectoryInfo ([string]$req.path)
        if (-not $dir.Exists) { throw "no folder at $($dir.FullName)" }
        $link = [IO.FileAttributes]::ReparsePoint
        if ($dir.Attributes -band $link) { throw "$($dir.FullName) is a link, so its target isn't changed" }
        $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $system = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
        $both = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
        # An owner can always change the list again, so anything another
        # account owns is taken over (Codex's third review). Administrators
        # and SYSTEM may own: they can do anything here anyway.
        $owners = @($me.Value, $system.Value, 'S-1-5-32-544')
        $sidType = [Security.Principal.SecurityIdentifier]
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $acl.SetAccessRuleProtection($true, $false)
        if ($owners -notcontains $dir.GetAccessControl('Owner').GetOwner($sidType).Value) { $acl.SetOwner($me) }
        foreach ($who in $me, $system) {
          $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($who, 'FullControl', $both, 'None', 'Allow')))
        }
        $dir.SetAccessControl($acl)
        $inside = @($dir.GetFileSystemInfos('*', [IO.SearchOption]::AllDirectories))
        foreach ($item in $inside) {
          if ($item.Attributes -band $link) { throw "$($item.FullName) is a link" }
          $own = if ($item -is [IO.DirectoryInfo]) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
          $own.SetAccessRuleProtection($false, $false)
          if ($owners -notcontains $item.GetAccessControl('Owner').GetOwner($sidType).Value) { $own.SetOwner($me) }
          $item.SetAccessControl($own)
        }
        $allowed = @($me.Value, $system.Value)
        foreach ($item in @($dir) + $inside) {
          $item.Refresh()
          $read = $item.GetAccessControl()
          $owner = $read.GetOwner($sidType).Value
          if ($owners -notcontains $owner) { throw "$($item.FullName) is still owned by $owner" }
          foreach ($rule in $read.GetAccessRules($true, $true, $sidType)) {
            if ($allowed -notcontains $rule.IdentityReference.Value) { throw "$($item.FullName) still lets $($rule.IdentityReference.Value) in" }
          }
        }
        $result = $me.Value
      }
      'environ' {
        # PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ. Offsets are
        # the 64-bit layout's (x64 and ARM64): the PEB from
        # ProcessBasicInformation (its address at 8), its ProcessParameters
        # at 0x20, and in those the Environment pointer at 0x80 and its size
        # at 0x3F0. A 32-bit (WoW64) process has a 64-bit PEB too, read the
        # same way. A 32-bit helper couldn't read a 64-bit process at all,
        # so it says so rather than answer for any.
        if ([IntPtr]::Size -ne 8) { throw 'the helper is a 32-bit process' }
        $lines = foreach ($p in ([string]$req.pids -split ',')) {
          if ($p -notmatch '^\d+$') { throw "not a pid: $p" }
          $proc = $K::OpenProcess(0x1010, $false, [UInt32]$p)
          if ($proc -eq [IntPtr]::Zero) {
            $err = LastError
            # 5: access denied (another user's, elevated, protected).
            # 87: no such process.
            if ($err -eq 5) { "x $p"; continue }
            if ($err -eq 87) { "g $p"; continue }
            throw "OpenProcess $p failed ($err)"
          }
          try {
            $read = {
              param([long]$at, [int]$size)
              $buf = New-Object byte[] $size
              if (-not $K::ReadProcessMemory($proc, [IntPtr]$at, $buf, [IntPtr]$size, [IntPtr]::Zero)) { return $null }
              ,$buf
            }
            $pbi = New-Object byte[] 48
            $status = $K::NtQueryInformationProcess($proc, 0, $pbi, 48, [IntPtr]::Zero)
            if ($status -ne 0) { "g $p"; continue }
            $peb = [BitConverter]::ToInt64($pbi, 8)
            $params = & $read ($peb + 0x20) 8
            $block = $null
            if ($null -ne $params) {
              $at = [BitConverter]::ToInt64($params, 0)
              $where = & $read ($at + 0x80) 8
              $size = & $read ($at + 0x3F0) 8
              if ($null -ne $where -and $null -ne $size) {
                $n = [BitConverter]::ToInt64($size, 0)
                # A block is at most 32,767 characters a variable, and
                # Windows caps the whole well under this.
                # Read from the process's own memory, which it can write: a
                # size out of range is no answer for it alone.
                if ($n -gt 0 -and $n -le 16777216) { $block = & $read ([BitConverter]::ToInt64($where, 0)) ([int]$n) }
              }
            }
            # A read that fails: the process is exiting (299, a partial
            # copy) or has gone; access denied after opening is "x".
            if ($null -eq $block) {
              $err = LastError
              if ($err -eq 5) { "x $p" } else { "g $p" }
            } else { "e $p $([Convert]::ToBase64String($block))" }
          } finally {
            [void]$K::CloseHandle($proc)
          }
        }
        $result = (@($lines) -join "`n")
      }
      'jobsOf' {
        if ([IntPtr]::Size -ne 8) { throw 'the helper is a 32-bit process' }
        # A thread's job is named in the Local namespace of its runner's
        # session, which is its CLI's and so its processes' too: each
        # process is looked for in its own session's directory
        # (\Sessions\<n>\BaseNamedObjects; session 0's is \BaseNamedObjects).
        $bySession = @{}
        try {
          $lines = foreach ($p in ([string]$req.pids -split ',')) {
            if ($p -notmatch '^\d+$') { throw "not a pid: $p" }
            # PROCESS_QUERY_LIMITED_INFORMATION
            $proc = $K::OpenProcess(0x1000, $false, [UInt32]$p)
            if ($proc -eq [IntPtr]::Zero) {
              $err = LastError
              if ($err -eq 87) { "g $p" } else { "x $p" }
              continue
            }
            try {
              # In no job at all (a terminal, the app): nothing to look up.
              $anyJob = $false
              # A failure here is no answer for this process alone, not for
              # every connection asked about with it (Gemini's review).
              if (-not $K::IsProcessInJob($proc, [IntPtr]::Zero, [ref]$anyJob)) { "g $p"; continue }
              if (-not $anyJob) { "j $p"; continue }
              $session = [UInt32]0
              if (-not $K::ProcessIdToSessionId([UInt32]$p, [ref]$session)) { "g $p"; continue }
              if (-not $bySession.ContainsKey($session)) {
                $dirName = if ($session -eq 0) { '\BaseNamedObjects' } else { "\Sessions\$session\BaseNamedObjects" }
                $bySession[$session] = JobsIn $dirName
              }
              $jobsHere = $bySession[$session]
              # Not $in: that's the helper's stdin (above).
              $member = foreach ($n in $jobsHere.Keys) {
                $hit = $false
                foreach ($h in $jobsHere[$n]) {
                  $yes = $false
                  if (-not $K::IsProcessInJob($proc, $h, [ref]$yes)) { throw "IsProcessInJob $p failed ($(LastError))" }
                  if ($yes) { $hit = $true }
                }
                if ($hit) { $n }
              }
              "j $p $(@($member) -join ',')".TrimEnd()
            } finally {
              [void]$K::CloseHandle($proc)
            }
          }
        } finally {
          foreach ($t in $bySession.Values) { foreach ($list in $t.Values) { foreach ($h in $list) { [void]$K::CloseHandle($h) } } }
        }
        $result = (@($lines) -join "`n")
      }
      'idle' {
        # LASTINPUTINFO: cbSize (8), then the tick count of the last input.
        # Both tick counts wrap at 2^32 ms (49.7 days), so the gap is taken
        # modulo that.
        $info = New-Object byte[] 8
        $info[0] = 8
        if (-not $K::GetLastInputInfo($info)) { throw "GetLastInputInfo failed ($(LastError))" }
        $last = [BitConverter]::ToUInt32($info, 4)
        $now = $K::GetTickCount()
        $result = [string](([long]$now - [long]$last + 4294967296) % 4294967296)
      }
      'awake' {
        # Held by this helper's own thread, which answers every question, so
        # it lasts until asked to let go or the helper ends (with the runner,
        # as its stdin closes). ES_CONTINUOUS, plus ES_SYSTEM_REQUIRED to
        # keep it: idle sleep only, as caffeinate -i on a Mac, so the screen
        # still turns off and locks.
        $flags = if ([int]$req.on -eq 1) { [UInt32]2147483649 } else { [UInt32]2147483648 }
        if ($K::SetThreadExecutionState($flags) -eq 0) { throw 'SetThreadExecutionState failed' }
        $result = if ([int]$req.on -eq 1) { 'held' } else { 'let go' }
      }
      'power' {
        # SYSTEM_POWER_STATUS: ACLineStatus (0 battery, 1 plugged in, 255
        # unknown), BatteryFlag (128: no battery), BatteryLifePercent (255
        # unknown), then more the runner doesn't need.
        $status = New-Object byte[] 12
        if (-not $K::GetSystemPowerStatus($status)) { throw "GetSystemPowerStatus failed ($(LastError))" }
        $battery = if ($status[0] -eq 0 -and $status[1] -ne 128) { 1 } else { 0 }
        $percent = if ($status[2] -eq 255) { -1 } else { [int]$status[2] }
        $result = "$battery $percent"
      }
      default { throw "unknown op: $($req.op)" }
    }
    $answer = @{ id = $id; ok = $true; result = [string]$result } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
  } catch {
    $answer = @{ id = $id; ok = $false; error = [string]$_ } | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
  }
  $out.WriteLine($answer)
  $out.Flush()
}
