# Installs the LookCam sync as a Windows scheduled task (current user, every 15 min + at logon).
# Run in PowerShell from this folder:  powershell -ExecutionPolicy Bypass -File .\install-task.ps1
param(
  [string]$HaHost = "192.168.1.35",
  [string]$SambaUser = "homeassistant",
  [int]$EveryMinutes = 15
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 1. Prerequisites
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js not found. Install it (winget install OpenJS.NodeJS.LTS) and re-run." }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning "ffmpeg not found in PATH. Install it: winget install Gyan.FFmpeg  (then open a new terminal), or set 'ffmpeg' in config.json."
}

# 2. Config
$cfg = Join-Path $here "config.json"
if (-not (Test-Path $cfg)) { Copy-Item (Join-Path $here "config.example.json") $cfg; Write-Host "Created $cfg (edit roi/threshold later)." }

# 3. Samba credentials in Windows Credential Manager (never in a script/file).
#    Uses the user env var SAMBA_PWD_CINDY if present, otherwise prompts.
$pwd = [Environment]::GetEnvironmentVariable('SAMBA_PWD_CINDY','User')
if (-not $pwd) {
  $sec = Read-Host "Samba password for $SambaUser@$HaHost" -AsSecureString
  $pwd = [Net.NetworkCredential]::new('', $sec).Password
}
cmdkey /add:$HaHost /user:$SambaUser /pass:$pwd | Out-Null
Remove-Variable pwd
Write-Host "Samba credentials stored for $HaHost (Credential Manager)."

# 4. Scheduled task (hidden window, does nothing if the share is unreachable)
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$here\lookcam-sync.cjs`" --config `"$cfg`"" -WorkingDirectory $here
$t1 = New-ScheduledTaskTrigger -AtLogOn
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "LookCam Sync" -Action $action -Trigger $t1,$t2 -Settings $settings `
  -Description "Fetch LookCam recordings from Home Assistant and extract motion clips" -Force | Out-Null
Write-Host "Scheduled task 'LookCam Sync' installed (every $EveryMinutes min + at logon)."
Write-Host "Test now:  node `"$here\lookcam-sync.cjs`" --config `"$cfg`""
