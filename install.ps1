# Installs (or updates) VibeCMD from the latest GitHub release.
#   PowerShell:  irm https://raw.githubusercontent.com/XAlienX123/vibecmd/main/install.ps1 | iex
#   CMD:         powershell -c "irm https://raw.githubusercontent.com/XAlienX123/vibecmd/main/install.ps1 | iex"
# Runs the installer silently for the current user, so no admin prompt.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'XAlienX123/vibecmd'
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'vibecmd-install' }
$asset = $release.assets | Where-Object { $_.name -match 'Setup.*\.exe$' } | Select-Object -First 1
if (-not $asset) { throw "No installer found in release $($release.tag_name)." }

$exe = Join-Path $env:TEMP $asset.name
Write-Host "==> Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB)" -ForegroundColor Magenta
Invoke-WebRequest $asset.browser_download_url -OutFile $exe -UseBasicParsing

# VibeCMD can't be replaced while it is running, and closing it for the user
# could lose work in busy panes.
if (Get-Process VibeCMD -ErrorAction SilentlyContinue) {
  Remove-Item $exe -ErrorAction SilentlyContinue
  throw 'VibeCMD is running. Close it, then run this command again.'
}

Write-Host '==> Installing' -ForegroundColor Magenta
$p = Start-Process $exe -ArgumentList '/S', '/currentuser' -Wait -PassThru
Remove-Item $exe -ErrorAction SilentlyContinue
if ($p.ExitCode -ne 0) { throw "The installer exited with code $($p.ExitCode)." }

if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Host "==> Claude panes need 'claude' (Claude Code) on your PATH: https://claude.com/claude-code" -ForegroundColor Yellow
}
Write-Host "==> VibeCMD $($release.tag_name) installed. Find it in the Start menu." -ForegroundColor Magenta
