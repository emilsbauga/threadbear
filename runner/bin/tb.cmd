@echo off
rem tb on Windows: cmd and PowerShell run this, Git Bash runs bin/tb.
rem The runner puts its own Node in THREADBEAR_NODE for its threads.
setlocal
set "TB_NODE=%THREADBEAR_NODE%"
if not defined TB_NODE set "TB_NODE=node"
"%TB_NODE%" "%~dp0tb" %*
