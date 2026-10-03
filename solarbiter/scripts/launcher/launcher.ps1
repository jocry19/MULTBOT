# SOLARBITER launcher for Windows — called by "SOLARBITER starten.bat" / "SOLARBITER stoppen.bat".
#
#   launcher.ps1 start   start (first run: setup), wait until ready, open the dashboard
#   launcher.ps1 stop    stop all containers (data is kept)
#
# Compatible with Windows PowerShell 5.1. Everything runs in Docker. Secrets are written only to
# .env (git-ignored); the dashboard password is passed via stdin, never as an argument.
param([ValidateSet('start', 'stop')][string]$Action = 'start')

# Native tools write progress to stderr; with 'Stop' Windows PowerShell 5.1 would treat that as an error.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'   # no progress bars (also much faster web requests in 5.1)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $Root
$EnvPath = Join-Path $Root '.env'
$DockerUrl = 'https://www.docker.com/products/docker-desktop/'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Info([string]$msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail([string]$msg) {
    Write-Host ''
    Write-Host "FEHLER: $msg" -ForegroundColor Red
    exit 1
}

# --- .env helpers (values are taken literally) -----------------------------------------------------
function Read-EnvLines {
    $text = [System.IO.File]::ReadAllText($EnvPath) -replace "`r`n", "`n"
    return , ($text -split "`n")
}
function Get-EnvValue([string]$key) {
    if (-not (Test-Path -LiteralPath $EnvPath)) { return '' }
    $value = ''
    foreach ($line in (Read-EnvLines)) {
        if ($line.StartsWith("$key=")) { $value = $line.Substring($key.Length + 1) }
    }
    return $value
}
function Set-EnvValue([string]$key, [string]$value) {
    $out = New-Object System.Collections.Generic.List[string]
    $done = $false
    foreach ($line in (Read-EnvLines)) {
        if ($line.StartsWith("$key=") -or $line.StartsWith("# $key=")) {
            if (-not $done) { $out.Add("$key=$value"); $done = $true }
            continue
        }
        $out.Add($line)
    }
    if (-not $done) {
        if ($out.Count -gt 0 -and $out[$out.Count - 1] -eq '') { $out.Insert($out.Count - 1, "$key=$value") } else { $out.Add("$key=$value") }
    }
    [System.IO.File]::WriteAllText($EnvPath, ($out -join "`n"), $Utf8NoBom)
}
function New-RandomHex([int]$bytes) {
    $buf = New-Object byte[] $bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($buf)
    $rng.Dispose()
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}
function ConvertTo-Plain([System.Security.SecureString]$secure) {
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Test-Http([string]$url) {
    try { $null = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3; return $true } catch { return $false }
}

# --- Docker ---------------------------------------------------------------------------------------
# Quiet checks go through cmd.exe so that stderr never reaches PowerShell's error stream.
function Test-Quiet([string]$command) {
    if ($IsLinux -or $IsMacOS) { & sh -c "$command >/dev/null 2>&1" } else { & cmd.exe /d /c "$command >nul 2>&1" }
    return ($LASTEXITCODE -eq 0)
}
function Test-DockerRunning { return (Test-Quiet 'docker info') }

function Confirm-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        $bin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
        if (Test-Path -LiteralPath (Join-Path $bin 'docker.exe')) { $env:Path = "$env:Path;$bin" }
    }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Host 'Docker ist nicht installiert. SOLARBITER braucht Docker Desktop (kostenlos):'
        Write-Host "  $DockerUrl"
        Start-Process $DockerUrl
        Fail 'Bitte Docker Desktop installieren, einmal starten und dann erneut doppelklicken.'
    }
    if (-not (Test-Quiet 'docker compose version')) { Fail "'docker compose' fehlt - bitte Docker Desktop aktualisieren." }
    if (Test-DockerRunning) { return }

    Info 'Docker läuft nicht - starte Docker Desktop …'
    $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path -LiteralPath $desktop) { Start-Process -FilePath $desktop }
    $waited = 0
    while (-not (Test-DockerRunning)) {
        if ($waited -ge 180) { Fail 'Docker ist nach 3 Minuten nicht bereit. Bitte Docker Desktop starten und erneut doppelklicken.' }
        Write-Host -NoNewline '.'
        Start-Sleep -Seconds 3
        $waited += 3
    }
    Write-Host ' bereit.'
}

# --- first run: .env ------------------------------------------------------------------------------
function Initialize-Env {
    if (Test-Path -LiteralPath $EnvPath) { return }
    if (Test-Quiet 'docker volume inspect solarbiter_pgdata') {
        Write-Host 'Es gibt bereits eine SOLARBITER-Datenbank, aber keine .env-Datei mehr (darin steht ihr Passwort).'
        Write-Host 'Entweder die alte .env wieder in diesen Ordner legen, oder die Datenbank löschen mit:'
        Write-Host '  docker volume rm solarbiter_pgdata'
        Fail 'Ersteinrichtung abgebrochen.'
    }
    Info 'Ersteinrichtung'
    $template = [System.IO.File]::ReadAllText((Join-Path $Root '.env.example')) -replace "`r`n", "`n"
    [System.IO.File]::WriteAllText($EnvPath, $template, $Utf8NoBom)
    Set-EnvValue 'POSTGRES_PASSWORD' (New-RandomHex 20)

    Write-Host ''
    Write-Host 'Solana-RPC: Empfohlen ist ein eigener Zugang, z. B. Helius:'
    Write-Host '  https://mainnet.helius-rpc.com/?api-key=DEIN_KEY'
    Write-Host 'Leer lassen = öffentlicher RPC (langsam und stark limitiert).'
    while ($true) {
        $rpc = ((Read-Host 'RPC-URL') -replace '\s', '')
        if ($rpc -eq '' -or $rpc.StartsWith('https://')) { break }
        Write-Host 'Die URL muss mit https:// beginnen.'
    }
    if ($rpc -ne '') {
        Set-EnvValue 'SOLANA_RPC_URL' $rpc
        Set-EnvValue 'SOLANA_RPC_FALLBACK_URLS' 'https://api.mainnet-beta.solana.com'
    }

    Write-Host ''
    Write-Host 'Jupiter-API-Key (optional, kostenlos unter https://developers.jup.ag) - verdoppelt das Quote-Budget.'
    $jup = ((Read-Host 'Jupiter-Key (leer = ohne)') -replace '\s', '')
    if ($jup -ne '') {
        Set-EnvValue 'JUPITER_API_KEY' $jup
        Set-EnvValue 'JUPITER_RPS' '1'
    }
    Write-Host ''
    Write-Host "Gespeichert in $EnvPath (nie in Git)."
}

# --- first run: dashboard user -------------------------------------------------------------------
function New-DashboardUserIfNeeded([string]$base) {
    try { $status = Invoke-RestMethod -UseBasicParsing -Uri "$base/api/auth/status" -TimeoutSec 5 } catch { return }
    if (-not $status.setupRequired) { return }

    Info 'Dashboard-Zugang anlegen'
    while ($true) {
        $user = Read-Host 'Benutzername [admin]'
        if ($user -eq '') { $user = 'admin' }
        if ($user -match '^[A-Za-z0-9_.-]{3,50}$') { break }
        Write-Host '3-50 Zeichen: Buchstaben, Ziffern, _ . -'
    }
    while ($true) {
        $pw = ConvertTo-Plain (Read-Host 'Passwort (mind. 12 Zeichen)' -AsSecureString)
        if ($pw.Length -lt 12) { Write-Host 'Zu kurz.'; continue }
        $pw2 = ConvertTo-Plain (Read-Host 'Passwort wiederholen' -AsSecureString)
        if ($pw -ceq $pw2) { break }
        Write-Host 'Die Passwörter stimmen nicht überein.'
    }
    $pw | & docker compose exec -T api node apps/api/dist/cli/user.js $user
    $code = $LASTEXITCODE
    $pw = $null; $pw2 = $null
    if ($code -ne 0) { Fail 'Benutzer konnte nicht angelegt werden.' }
}

# --- commands -------------------------------------------------------------------------------------
function Start-Solarbiter {
    Write-Host 'SOLARBITER - Start'
    Confirm-Docker
    Initialize-Env
    $null = New-Item -ItemType Directory -Force -Path (Join-Path $Root 'secrets')

    Info 'Starte SOLARBITER (beim ersten Mal wird das Programm gebaut - das dauert einige Minuten) …'
    & docker compose up -d --build --remove-orphans
    if ($LASTEXITCODE -ne 0) {
        & docker compose logs --tail 40 migrate api worker
        Fail 'Start fehlgeschlagen (Details oben).'
    }

    $port = Get-EnvValue 'HTTP_PORT'
    if ($port -eq '') { $port = '8788' }
    $base = "http://127.0.0.1:$port"
    Info 'Warte auf das Dashboard …'
    $waited = 0
    while (-not (Test-Http "$base/api/health")) {
        if ($waited -ge 180) {
            & docker compose logs --tail 40 api
            Fail "Das Dashboard antwortet nicht unter $base."
        }
        Start-Sleep -Seconds 2
        $waited += 2
    }

    New-DashboardUserIfNeeded $base

    Info "SOLARBITER läuft: $base"
    & docker compose ps --format 'table {{.Service}}\t{{.Status}}'
    try { Start-Process $base } catch { }
    Write-Host ''
    Write-Host 'Der Bot läuft im Hintergrund weiter (Paper-Modus), auch wenn du dieses Fenster schließt.'
    Write-Host 'Beenden: Doppelklick auf "SOLARBITER stoppen". Echtgeld bleibt gesperrt, bis du es'
    Write-Host 'nach erfolgreicher Validierung im Dashboard selbst freigibst.'
}

function Stop-Solarbiter {
    Write-Host 'SOLARBITER - Stopp'
    if (-not (Get-Command docker -ErrorAction SilentlyContinue) -or -not (Test-DockerRunning)) {
        Write-Host 'Docker läuft nicht - SOLARBITER ist bereits gestoppt.'
        return
    }
    & docker compose down
    if ($LASTEXITCODE -ne 0) { Fail 'Stoppen fehlgeschlagen.' }
    Write-Host ''
    Write-Host 'SOLARBITER ist gestoppt. Alle Daten (Datenbank, Einstellungen, Trades) bleiben erhalten.'
}

if ($Action -eq 'stop') { Stop-Solarbiter } else { Start-Solarbiter }
exit 0
