$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $RepoRoot 'dist\cli.mjs'

if (-not (Test-Path $Cli)) {
  Push-Location $RepoRoot
  try {
    npm run build | Out-Host
  } finally {
    Pop-Location
  }
}

node $Cli @args
