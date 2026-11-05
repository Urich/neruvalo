[CmdletBinding()]
param(
    [string]$GateDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) '..\gateveriq'),
    [string]$GateConfig = 'config.toml',
    [ValidateRange(1, 65535)]
    [int]$ServerPort = 8787,
    [string]$GateInternal = 'http://127.0.0.1:9081',
    [string]$GatePublic = 'http://127.0.0.1:9080'
)

$ErrorActionPreference = 'Stop'
$GateDirectory = (Resolve-Path -LiteralPath $GateDirectory).Path
if (-not [IO.Path]::IsPathRooted($GateConfig)) {
    $GateConfig = Join-Path $GateDirectory $GateConfig
}
$GateConfig = (Resolve-Path -LiteralPath $GateConfig).Path
$origin = "http://127.0.0.1:$ServerPort"
$credentialsPath = Join-Path $PSScriptRoot 'local-data\gateveriq-integration.json'
$launcherPath = Join-Path $PSScriptRoot 'start-dev-server-gate.cmd'

# Values are written into a batch file: reject batch expansion and metacharacters.
foreach ($url in @($GateInternal, $GatePublic)) {
    $parsed = $null
    if ($url -notmatch '^https?://[a-zA-Z0-9.:-]+$' -or
        -not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsed)) {
        throw "Expected an HTTP(S) origin without trailing slash: $url"
    }
}
Get-Command cargo -ErrorAction Stop | Out-Null

function Invoke-Gate {
    param([string[]]$GateArguments)
    $result = & cargo run --quiet --locked -- --config $GateConfig @GateArguments
    if ($LASTEXITCODE -ne 0) {
        throw "GateVeriq command failed: $($GateArguments[0])"
    }
    return ($result -join "`n")
}

Push-Location -LiteralPath $GateDirectory
try {
    if (Test-Path -LiteralPath $credentialsPath) {
        $saved = Get-Content -LiteralPath $credentialsPath -Raw | ConvertFrom-Json
        if ($saved.origin -ne $origin -or $saved.config -ne $GateConfig) {
            throw 'Saved integration uses another origin/config. Use its original settings or move local-data\gateveriq-integration.json aside to create a new integration.'
        }
        $integration = $saved
        Write-Host 'Reusing saved Neruvalo integration.'
    } else {
        Write-Host 'Creating Neruvalo integration (Cargo may compile GateVeriq)...'
        $integration = Invoke-Gate -GateArguments @(
            'integration-create', '--name', 'neruvalo',
            '--actions', 'register,login', '--origins', $origin
        ) | ConvertFrom-Json
        if (-not $integration.integration_id -or -not $integration.integration_secret) {
            throw 'GateVeriq did not return integration credentials.'
        }
        New-Item -ItemType Directory -Path (Split-Path $credentialsPath -Parent) -Force | Out-Null
        # Save immediately so a policy failure can be retried without a new integration.
        [pscustomobject]@{
            integration_id = $integration.integration_id
            integration_secret = $integration.integration_secret
            origin = $origin
            config = $GateConfig
        } | ConvertTo-Json | Set-Content -LiteralPath $credentialsPath -Encoding UTF8
    }

    foreach ($action in @('register', 'login')) {
        $policy = 'adaptive'
        Invoke-Gate -GateArguments @(
            'integration-visual-policy', '--id', $integration.integration_id,
            '--action', $action, '--visual', $policy
        ) | Out-Null
    }
} finally {
    Pop-Location
}

foreach ($value in @($integration.integration_id, $integration.integration_secret)) {
    if ($value -notmatch '^[A-Za-z0-9_-]+$') {
        throw 'Invalid integration credentials.'
    }
}

$launcher = @"
@echo off
setlocal
cd /d "%~dp0"
if not exist "local-data" mkdir "local-data"
set "NERUVALO_DEV_MODE=true"
set "DATABASE_URL=sqlite://local-data/server.sqlite3?mode=rwc"
set "NERUVALO_DEV_OUTBOX=local-data/dev-outbox"
set "NERUVALO_LISTEN=127.0.0.1:$ServerPort"
set "NERUVALO_GATE_ID=$($integration.integration_id)"
set "NERUVALO_GATE_SECRET=$($integration.integration_secret)"
set "NERUVALO_GATE_INTERNAL=$GateInternal"
set "NERUVALO_GATE_PUBLIC=$GatePublic"
set "NERUVALO_PUBLIC_ORIGIN=$origin"
echo Neruvalo prototype server: $origin
echo Keep GateVeriq running with the config used during setup.
echo Email confirmation codes: local-data\dev-outbox
"%~dp0neruvalo-server.exe"
echo Server stopped.
pause
"@
[IO.File]::WriteAllText($launcherPath, ($launcher -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)
Write-Host "Setup complete. Start Neruvalo using: $launcherPath"
Write-Host 'The launcher and local-data integration JSON contain the integration secret. Keep them private.'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'neruvalo-server.exe'))) {
    Write-Host 'Place neruvalo-server.exe beside the generated CMD before starting it.'
}
