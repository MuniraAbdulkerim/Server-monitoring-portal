<#
.SYNOPSIS
    Windows Monitoring Collector for the Server Monitoring Portal.

.DESCRIPTION
    Collects CPU, memory, disk, uptime, network, service, and backup metrics
    from a Windows machine and POSTs them to POST /api/v1/health.

    Each registered server has its own unique agent token (per-server auth).
    The token is NEVER printed or logged.

.PARAMETER Once
    Collect metrics exactly once, submit, display summary, then exit.
    Without this switch the collector loops every COLLECTION_INTERVAL_SECONDS.

.PARAMETER ConfigFile
    Path to the .env config file.  Defaults to .env in the same directory
    as this script.

.EXAMPLE
    # One-shot test
    powershell -ExecutionPolicy Bypass -File .\collector.ps1 -Once

    # Continuous mode (60-second interval by default)
    powershell -ExecutionPolicy Bypass -File .\collector.ps1

.NOTES
    Requirements:
      - PowerShell 5.1+ (Windows PowerShell) or PowerShell 7+
      - CIM/WMI access (local administrator recommended)
      - Network access to the backend API
#>

[CmdletBinding()]
param(
    [switch]$Once,
    [string]$ConfigFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"   # never let one error stop the loop

# ---------------------------------------------------------------------------
# 0. Helpers
# ---------------------------------------------------------------------------

function Write-Log {
    param([string]$Level, [string]$Message)
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    # Pad level for alignment
    $padded = $Level.PadRight(5)
    Write-Host "[$ts] [$padded] $Message"
}

function Write-Info  { param([string]$m) Write-Log "INFO"  $m }
function Write-Warn  { param([string]$m) Write-Log "WARN"  $m }
function Write-Err   { param([string]$m) Write-Log "ERROR" $m }

# ---------------------------------------------------------------------------
# 1. Configuration loader
# ---------------------------------------------------------------------------

function Get-Config {
    param([string]$ConfigPath)

    # Default config values
    $cfg = @{
        API_URL                    = "http://localhost:4000/api/v1/health"
        AGENT_API_TOKEN            = ""
        SERVER_ID                  = ""
        COLLECTION_INTERVAL_SECONDS = 60
        IMPORTANT_SERVICES         = "spooler,w32time,WinDefend,EventLog,Dnscache"
        BACKUP_ENABLED             = $true
        HTTP_TIMEOUT_SECONDS       = 15
    }

    # Resolve config file path
    if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
        $ConfigPath = Join-Path $PSScriptRoot ".env"
    }

    # Load .env file if it exists
    if (Test-Path $ConfigPath) {
        Write-Info "Loading config from: $ConfigPath"
        Get-Content $ConfigPath -Encoding UTF8 | ForEach-Object {
            $line = $_.Trim()
            if ($line -and -not $line.StartsWith("#")) {
                $idx = $line.IndexOf("=")
                if ($idx -gt 0) {
                    $key = $line.Substring(0, $idx).Trim()
                    $val = $line.Substring($idx + 1).Trim()
                    # Strip inline comments
                    $commentIdx = $val.IndexOf(" #")
                    if ($commentIdx -gt 0) { $val = $val.Substring(0, $commentIdx).Trim() }
                    if ($cfg.ContainsKey($key)) {
                        $cfg[$key] = $val
                    }
                }
            }
        }
    }
    else {
        Write-Warn "Config file not found at '$ConfigPath' — using environment variables only"
    }

    # Environment variables override file values (standard 12-factor pattern)
    $envKeys = @("API_URL","AGENT_API_TOKEN","SERVER_ID",
                 "COLLECTION_INTERVAL_SECONDS","IMPORTANT_SERVICES",
                 "BACKUP_ENABLED","HTTP_TIMEOUT_SECONDS")
    foreach ($k in $envKeys) {
        $envVal = [System.Environment]::GetEnvironmentVariable($k)
        if (-not [string]::IsNullOrWhiteSpace($envVal)) {
            $cfg[$k] = $envVal
        }
    }

    # Type coercions
    $cfg.COLLECTION_INTERVAL_SECONDS = [int]$cfg.COLLECTION_INTERVAL_SECONDS
    $cfg.HTTP_TIMEOUT_SECONDS        = [int]$cfg.HTTP_TIMEOUT_SECONDS
    if ($cfg.COLLECTION_INTERVAL_SECONDS -lt 10) { $cfg.COLLECTION_INTERVAL_SECONDS = 10 }

    $boolStr = [string]$cfg.BACKUP_ENABLED
    $cfg.BACKUP_ENABLED = ($boolStr -match "^(true|1|yes)$")

    # Default SERVER_ID from hostname
    if ([string]::IsNullOrWhiteSpace($cfg.SERVER_ID)) {
        $cfg.SERVER_ID = "srv-" + ([System.Net.Dns]::GetHostName().ToLower())
    }

    return $cfg
}

function Assert-Config {
    param([hashtable]$Config)
    $ok = $true
    if ([string]::IsNullOrWhiteSpace($Config.AGENT_API_TOKEN)) {
        Write-Err "AGENT_API_TOKEN is not set."
        Write-Err "Register this server in the inventory UI to obtain a token,"
        Write-Err "then set AGENT_API_TOKEN in the .env file."
        $ok = $false
    }
    if ([string]::IsNullOrWhiteSpace($Config.API_URL)) {
        Write-Err "API_URL is not set."
        $ok = $false
    }
    return $ok
}

# ---------------------------------------------------------------------------
# 2. Metric collectors
# ---------------------------------------------------------------------------

function Get-CpuUsage {
    <#
    Returns CPU usage as a float 0–100.
    Uses a 1-second measurement window for accuracy.
    Falls back to WMI on older systems.
    #>
    try {
        # LoadPercentage is a single instantaneous reading — we average two
        # samples 1 s apart for a more stable reading
        $s1 = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop |
               Measure-Object -Property LoadPercentage -Average).Average
        Start-Sleep -Milliseconds 1000
        $s2 = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop |
               Measure-Object -Property LoadPercentage -Average).Average
        return [Math]::Round(($s1 + $s2) / 2.0, 1)
    }
    catch {
        Write-Warn "CPU: CIM query failed — $($_.Exception.Message)"
        return $null
    }
}

function Get-MemoryUsage {
    <#
    Returns a hashtable with:
      UsedPercent   — 0-100
      TotalBytes
      AvailableBytes
    #>
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $total     = [long]$os.TotalVisibleMemorySize * 1024   # KB → bytes
        $available = [long]$os.FreePhysicalMemory    * 1024
        $used      = $total - $available
        $pct       = if ($total -gt 0) { [Math]::Round($used / $total * 100.0, 1) } else { 0.0 }
        return @{
            UsedPercent    = $pct
            TotalBytes     = $total
            AvailableBytes = $available
        }
    }
    catch {
        Write-Warn "Memory: CIM query failed — $($_.Exception.Message)"
        return $null
    }
}

function Get-DiskUsage {
    <#
    Returns an array of hashtables, one per fixed logical disk:
      Mount        — drive letter, e.g. "C:"
      UsedPercent  — 0-100
      TotalBytes
      FreeBytes
    Only DriveType 3 (fixed) disks are included.
    CD/DVD (5) and removable (2) are excluded unless overridden.
    #>
    $disks = @()
    try {
        $drives = Get-CimInstance -ClassName Win32_LogicalDisk `
                    -Filter "DriveType=3" -ErrorAction Stop
        foreach ($d in $drives) {
            $total = [long]$d.Size
            $free  = [long]$d.FreeSpace
            if ($total -le 0) { continue }
            $pct = [Math]::Round(($total - $free) / $total * 100.0, 1)
            $disks += @{
                Mount       = $d.DeviceID          # "C:", "D:", etc.
                UsedPercent = $pct
                TotalBytes  = $total
                FreeBytes   = $free
            }
        }
    }
    catch {
        Write-Warn "Disk: CIM query failed — $($_.Exception.Message)"
    }
    return $disks
}

function Get-UptimeInfo {
    <#
    Returns a hashtable:
      UptimeSeconds  — integer
      LastBootTime   — ISO 8601 UTC string
    #>
    try {
        $os       = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $bootTime = $os.LastBootUpTime                       # already a [DateTime]
        $uptime   = [int]([DateTime]::UtcNow - $bootTime.ToUniversalTime()).TotalSeconds
        $iso      = $bootTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        return @{
            UptimeSeconds = $uptime
            LastBootTime  = $iso
        }
    }
    catch {
        Write-Warn "Uptime: CIM query failed — $($_.Exception.Message)"
        return $null
    }
}

function Get-NetworkStatus {
    <#
    Returns "up" if at least one non-loopback adapter has a valid IP,
    otherwise "down".
    #>
    try {
        $adapters = Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration `
                        -Filter "IPEnabled=True" -ErrorAction Stop |
                    Where-Object { $_.IPAddress -and
                                   ($_.IPAddress | Where-Object { $_ -ne "127.0.0.1" -and $_ -notlike "169.254.*" }) }
        if ($adapters) { return "up" } else { return "down" }
    }
    catch {
        Write-Warn "Network: CIM query failed — $($_.Exception.Message)"
        return "unknown"
    }
}

function Get-SystemInfo {
    <#
    Returns a hashtable:
      Hostname
      OSCaption    — friendly OS name
      OSVersion    — version string
    #>
    try {
        $os   = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $comp = Get-CimInstance -ClassName Win32_ComputerSystem  -ErrorAction Stop
        return @{
            Hostname   = $comp.DNSHostName
            OSCaption  = $os.Caption
            OSVersion  = $os.Version
        }
    }
    catch {
        Write-Warn "SystemInfo: CIM query failed — $($_.Exception.Message)"
        return @{
            Hostname  = $env:COMPUTERNAME
            OSCaption = "Windows"
            OSVersion = ""
        }
    }
}

function Get-ServiceStatus {
    <#
    Checks the configured list of important Windows services.
    Returns an array of hashtables:
      Name     — service short name
      Status   — "running" | "stopped" | "unknown"
    A failure on one service does NOT abort the rest.
    #>
    param([string]$ServiceList)

    $results = @()
    $names   = $ServiceList -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }

    foreach ($svc in $names) {
        try {
            $s = Get-Service -Name $svc -ErrorAction Stop
            $results += @{
                Name   = $svc
                Status = $s.Status.ToString().ToLower()   # "running" | "stopped" | etc.
            }
        }
        catch {
            # Service does not exist on this machine — report unknown, don't crash
            $results += @{ Name = $svc; Status = "unknown" }
        }
    }
    return $results
}

# ---------------------------------------------------------------------------
# 3. Backup adapters
# ---------------------------------------------------------------------------

function Get-BackupStatus-WindowsServerBackup {
    <#
    Queries Windows Server Backup via wbadmin.
    Returns a hashtable compatible with the API backupStatus field.
    #>
    $result = @{
        status         = "unknown"
        lastBackupTime = $null
        sizeBytes      = $null
        source         = "windows-server-backup"
    }

    # wbadmin must be available
    $wbPath = "$env:SystemRoot\System32\wbadmin.exe"
    if (-not (Test-Path $wbPath)) {
        $result.source = "not-installed"
        return $result
    }

    try {
        # "get versions" lists completed backup sets
        $output = & $wbPath get versions 2>&1
        if ($LASTEXITCODE -ne 0 -or $null -eq $output) {
            return $result
        }

        $lines = $output | Where-Object { $_ -match "\S" }
        if (-not $lines) { return $result }

        # Parse the most recent entry
        $lastBackupLine = $lines | Where-Object { $_ -match "Backup time" } | Select-Object -Last 1
        $sizeLine       = $lines | Where-Object { $_ -match "Backup size" } | Select-Object -Last 1
        $successLine    = $lines | Where-Object { $_ -match "Recoverable" } | Select-Object -Last 1

        if ($lastBackupLine -match ":\s*(.+)$") {
            try {
                $parsed = [DateTime]::Parse($Matches[1].Trim())
                $result.lastBackupTime = $parsed.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            }
            catch { <# date parse failed — leave null #> }
        }

        if ($sizeLine -match ":\s*([\d,\.]+)\s*(\w+)") {
            try {
                $num  = [double]($Matches[1] -replace ",","")
                $unit = $Matches[2].ToLower()
                $bytes = switch ($unit) {
                    "gb" { [long]($num * 1GB) }
                    "mb" { [long]($num * 1MB) }
                    "kb" { [long]($num * 1KB) }
                    default { [long]$num }
                }
                $result.sizeBytes = $bytes
            }
            catch { <# size parse failed — leave null #> }
        }

        # "Recoverable" items in output means the backup completed usably
        if ($successLine -match "\d+") {
            $result.status = "success"
        }
        elseif ($result.lastBackupTime) {
            $result.status = "success"
        }
    }
    catch {
        Write-Warn "Backup: wbadmin query failed — $($_.Exception.Message)"
    }

    return $result
}

function Get-BackupStatus {
    <#
    Dispatcher — calls the appropriate backup adapter.
    Future adapters (Veeam, Bacula, rsync) can be added here.
    #>
    param([bool]$Enabled)

    if (-not $Enabled) {
        return @{
            status         = "unknown"
            lastBackupTime = $null
            sizeBytes      = $null
            source         = "disabled"
        }
    }

    # Primary adapter: Windows Server Backup
    $wsb = Get-BackupStatus-WindowsServerBackup
    if ($wsb.source -ne "not-installed") {
        return $wsb
    }

    # Future hook — add more adapters here:
    # $veeam = Get-BackupStatus-Veeam; if ($veeam) { return $veeam }
    # $bacula = Get-BackupStatus-Bacula; if ($bacula) { return $bacula }

    return @{
        status         = "unknown"
        lastBackupTime = $null
        sizeBytes      = $null
        source         = "not-configured"
    }
}

# ---------------------------------------------------------------------------
# 4. Payload builder
# ---------------------------------------------------------------------------

function Build-Payload {
    param([hashtable]$Config)

    Write-Info "Collecting metrics..."

    # --- System info (always) ---
    $sysInfo = Get-SystemInfo

    # --- CPU ---
    $cpu = Get-CpuUsage
    if ($null -eq $cpu) {
        Write-Warn "CPU metric unavailable — using 0.0 as safe default"
        $cpu = 0.0
    }

    # --- Memory ---
    $mem = Get-MemoryUsage
    $memPct = if ($mem) { $mem.UsedPercent } else {
        Write-Warn "Memory metric unavailable — using 0.0 as safe default"
        0.0
    }

    # --- Disk ---
    $rawDisks = Get-DiskUsage
    $diskUsage = @()
    foreach ($d in $rawDisks) {
        $diskUsage += @{ mount = $d.Mount; usedPercent = $d.UsedPercent }
    }

    # --- Uptime ---
    $uptimeInfo = Get-UptimeInfo
    $uptimeSecs  = if ($uptimeInfo) { $uptimeInfo.UptimeSeconds } else { $null }
    $lastBoot    = if ($uptimeInfo) { $uptimeInfo.LastBootTime  } else { $null }

    # --- Network ---
    $netStatus = Get-NetworkStatus

    # --- Services ---
    $services = Get-ServiceStatus -ServiceList $Config.IMPORTANT_SERVICES

    # --- Backup ---
    $backup = Get-BackupStatus -Enabled $Config.BACKUP_ENABLED

    # Build the payload compatible with Phase 1 POST /api/v1/health schema
    $payload = [ordered]@{
        hostname      = $sysInfo.Hostname
        os            = "windows"
        cpuUsage      = $cpu
        memoryUsage   = $memPct
        diskUsage     = $diskUsage
        networkStatus = $netStatus
        backupStatus  = $backup
    }

    # Optional fields — only include if we have real data
    if ($null -ne $uptimeSecs) { $payload.uptimeSeconds = $uptimeSecs }
    if ($null -ne $lastBoot)   { $payload.lastBootTime  = $lastBoot   }

    # Services are carried as extra metadata inside backupStatus.services
    # (backupStatus is JSONB in the DB — any extra keys are stored fine)
    # We surface services separately so the dashboard can display them later.
    $payload.backupStatus.services = $services

    return $payload
}

# ---------------------------------------------------------------------------
# 5. HTTP submission
# ---------------------------------------------------------------------------

function Submit-Payload {
    param(
        [hashtable]$Config,
        [hashtable]$Payload
    )

    $json    = $Payload | ConvertTo-Json -Depth 10 -Compress
    $timeout = $Config.HTTP_TIMEOUT_SECONDS

    # Build headers — token is used here and NEVER printed
    $headers = @{
        "Content-Type"  = "application/json"
        "Authorization" = "Bearer " + $Config.AGENT_API_TOKEN
    }

    $maxAttempts  = 3
    $backoffSecs  = @(0, 5, 15)   # wait before attempts 1, 2, 3

    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $wait = $backoffSecs[$attempt - 1]
        if ($wait -gt 0) {
            Write-Warn "Retrying in ${wait}s (attempt $attempt / $maxAttempts)..."
            Start-Sleep -Seconds $wait
        }

        try {
            $response = Invoke-WebRequest `
                -Uri     $Config.API_URL `
                -Method  POST `
                -Headers $headers `
                -Body    $json `
                -TimeoutSec $timeout `
                -UseBasicParsing `
                -ErrorAction Stop

            $code = [int]$response.StatusCode

            if ($code -eq 201) {
                try {
                    $body = $response.Content | ConvertFrom-Json
                    Write-Info "Submitted OK — id=$($body.id)  receivedAt=$($body.receivedAt)"
                }
                catch {
                    Write-Info "Submitted OK — HTTP 201"
                }
                return @{ Success = $true; StatusCode = 201 }
            }
            else {
                Write-Warn "Unexpected HTTP $code from API"
                return @{ Success = $false; StatusCode = $code }
            }
        }
        catch [System.Net.WebException] {
            $webEx = $_.Exception
            if ($null -ne $webEx.Response) {
                $code = [int]$webEx.Response.StatusCode

                if ($code -eq 401) {
                    Write-Err "Authentication rejected (HTTP 401) — verify AGENT_API_TOKEN matches the registered token."
                    return @{ Success = $false; StatusCode = 401 }   # don't retry auth failures
                }
                if ($code -eq 400) {
                    $body = ""
                    try {
                        $reader = New-Object System.IO.StreamReader($webEx.Response.GetResponseStream())
                        $body   = $reader.ReadToEnd()
                        $reader.Close()
                    } catch {}
                    Write-Err "Validation error (HTTP 400): $body"
                    return @{ Success = $false; StatusCode = 400 }   # don't retry validation errors
                }
                if ($code -eq 422) {
                    Write-Err "Server not registered in inventory (HTTP 422) — register first via the dashboard."
                    return @{ Success = $false; StatusCode = 422 }
                }

                Write-Warn "API returned HTTP $code"
            }
            else {
                # Connection-level failure — retryable
                Write-Warn "Cannot reach API: $($webEx.Message)"
            }
        }
        catch {
            Write-Warn "HTTP request failed: $($_.Exception.GetType().Name) — $($_.Exception.Message)"
        }
    }

    Write-Warn "All $maxAttempts attempts failed — will retry on next cycle"
    return @{ Success = $false; StatusCode = 0 }
}

# ---------------------------------------------------------------------------
# 6. Summary display (safe — never prints the token)
# ---------------------------------------------------------------------------

function Show-Summary {
    param([hashtable]$Payload)

    Write-Host ""
    Write-Host "  ---- Metrics Summary ----"
    Write-Host ("  Hostname      : {0}" -f $Payload.hostname)
    Write-Host ("  OS            : {0}" -f $Payload.os)
    Write-Host ("  CPU Usage     : {0}%" -f $Payload.cpuUsage)
    Write-Host ("  Memory Usage  : {0}%" -f $Payload.memoryUsage)

    foreach ($d in $Payload.diskUsage) {
        Write-Host ("  Disk {0,-6}    : {1}%" -f $d.mount, $d.usedPercent)
    }

    if ($Payload.ContainsKey("uptimeSeconds")) {
        $u = $Payload.uptimeSeconds
        $d = [Math]::Floor($u / 86400)
        $h = [Math]::Floor(($u % 86400) / 3600)
        Write-Host ("  Uptime        : {0}d {1}h ({2}s)" -f $d, $h, $u)
    }

    Write-Host ("  Network       : {0}" -f $Payload.networkStatus)
    Write-Host ("  Backup status : {0} (source: {1})" -f $Payload.backupStatus.status, $Payload.backupStatus.source)

    $svcs = $Payload.backupStatus.services
    if ($svcs -and $svcs.Count -gt 0) {
        Write-Host "  Services      :"
        foreach ($s in $svcs) {
            Write-Host ("    {0,-24} {1}" -f $s.Name, $s.Status)
        }
    }
    Write-Host "  -------------------------"
    Write-Host ""
}

# ---------------------------------------------------------------------------
# 7. Main entry point
# ---------------------------------------------------------------------------

$config = Get-Config -ConfigPath $ConfigFile

if (-not (Assert-Config -Config $config)) {
    exit 1
}

Write-Info "Windows Collector starting"
Write-Info "API URL   : $($config.API_URL)"
Write-Info "Server ID : $($config.SERVER_ID)"
Write-Info "Interval  : $($config.COLLECTION_INTERVAL_SECONDS)s"
if ($Once) {
    Write-Info "Mode      : once"
} else {
    Write-Info "Mode      : continuous  (Ctrl+C to stop)"
}
Write-Host ""

if ($Once) {
    # -----------------------------------------------------------------------
    # One-shot mode
    # -----------------------------------------------------------------------
    $payload = Build-Payload -Config $config
    Show-Summary -Payload $payload
    $result  = Submit-Payload -Config $config -Payload $payload
    if ($result.Success) {
        Write-Info "One-shot completed successfully."
        exit 0
    }
    else {
        Write-Err "One-shot completed with errors (HTTP $($result.StatusCode))."
        exit 1
    }
}
else {
    # -----------------------------------------------------------------------
    # Continuous mode
    # -----------------------------------------------------------------------
    while ($true) {
        try {
            $payload = Build-Payload -Config $config
            $null    = Submit-Payload -Config $config -Payload $payload
        }
        catch {
            Write-Err "Unexpected error in collection loop: $($_.Exception.Message)"
            # Never let an unhandled exception kill the daemon
        }

        Write-Info "Next collection in $($config.COLLECTION_INTERVAL_SECONDS)s"
        Start-Sleep -Seconds $config.COLLECTION_INTERVAL_SECONDS
    }
}
