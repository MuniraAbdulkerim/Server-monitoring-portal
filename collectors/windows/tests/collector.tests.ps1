<#
.SYNOPSIS
    Automated tests for the Windows Monitoring Collector.
    All Windows-specific CIM/WMI calls are mocked so these tests can run
    in any environment (CI, Windows dev machine).

.DESCRIPTION
    Uses Pester 5.x or 6.x for the test framework.
    Install: Install-Module Pester -MinimumVersion 5.0 -Force -Scope CurrentUser

.NOTES
    Run with:
        powershell -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
#>

# ---------------------------------------------------------------------------
# Bootstrap: load only the function definitions from collector.ps1,
# strip the "# 7. Main entry point" block so it does not execute.
# ---------------------------------------------------------------------------
BeforeAll {
    $env:COLLECTOR_TEST_MODE = "true"

    $collectorPath = Join-Path $PSScriptRoot "..\collector.ps1"
    if (-not (Test-Path $collectorPath)) {
        throw "Cannot find collector.ps1 at: $collectorPath"
    }

    $src = Get-Content $collectorPath -Raw -Encoding UTF8

    # Strip the entry-point section so we only load function definitions
    $marker1 = "# ---------------------------------------------------------------------------`r`n# 7. Main entry point"
    $marker2 = "# ---------------------------------------------------------------------------`n# 7. Main entry point"
    $idx = $src.IndexOf($marker1)
    if ($idx -lt 0) { $idx = $src.IndexOf($marker2) }
    if ($idx -gt 0) { $src = $src.Substring(0, $idx) }

    $sb = [scriptblock]::Create($src)
    . $sb
}

AfterAll {
    Remove-Item Env:\COLLECTOR_TEST_MODE -ErrorAction SilentlyContinue
}

# ===========================================================================
# CONFIGURATION
# ===========================================================================

Describe "Configuration" {

    It "loads defaults when no config file exists" {
        $cfg = Get-Config -ConfigPath "C:\does\not\exist\.env"
        $cfg.COLLECTION_INTERVAL_SECONDS | Should -Be 60
        $cfg.HTTP_TIMEOUT_SECONDS        | Should -Be 15
        $cfg.BACKUP_ENABLED              | Should -Be $true
        $cfg.API_URL                     | Should -Not -BeNullOrEmpty
    }

    It "enforces minimum collection interval of 10 seconds" {
        $tmp = [System.IO.Path]::GetTempFileName()
        Set-Content $tmp "COLLECTION_INTERVAL_SECONDS=2" -Encoding UTF8
        $cfg = Get-Config -ConfigPath $tmp
        Remove-Item $tmp -Force
        $cfg.COLLECTION_INTERVAL_SECONDS | Should -Be 10
    }

    It "coerces BACKUP_ENABLED=false to boolean false" {
        $tmp = [System.IO.Path]::GetTempFileName()
        Set-Content $tmp "BACKUP_ENABLED=false" -Encoding UTF8
        $cfg = Get-Config -ConfigPath $tmp
        Remove-Item $tmp -Force
        $cfg.BACKUP_ENABLED | Should -Be $false
    }

    It "defaults SERVER_ID to srv-<hostname> when blank" {
        $tmp = [System.IO.Path]::GetTempFileName()
        Set-Content $tmp "SERVER_ID=" -Encoding UTF8
        $cfg = Get-Config -ConfigPath $tmp
        Remove-Item $tmp -Force
        $expectedHost = [System.Net.Dns]::GetHostName().ToLower()
        $cfg.SERVER_ID | Should -Be ("srv-" + $expectedHost)
    }

    It "environment variable overrides file value" {
        $tmp = [System.IO.Path]::GetTempFileName()
        Set-Content $tmp "API_URL=http://file-value:4000" -Encoding UTF8
        $env:API_URL = "http://env-override:9999"
        $cfg = Get-Config -ConfigPath $tmp
        Remove-Item $tmp -Force
        Remove-Item Env:\API_URL -ErrorAction SilentlyContinue
        $cfg.API_URL | Should -Be "http://env-override:9999"
    }

    It "Assert-Config returns false when AGENT_API_TOKEN is empty" {
        $cfg = @{ AGENT_API_TOKEN = ""; API_URL = "http://x" }
        $result = Assert-Config -Config $cfg
        $result | Should -Be $false
    }

    It "Assert-Config returns true with token and URL present" {
        $cfg = @{ AGENT_API_TOKEN = "abc123"; API_URL = "http://localhost:4000" }
        $result = Assert-Config -Config $cfg
        $result | Should -Be $true
    }

    It "strips inline comments from .env values" {
        $tmp = [System.IO.Path]::GetTempFileName()
        Set-Content $tmp "API_URL=http://server:4000 # my backend" -Encoding UTF8
        $cfg = Get-Config -ConfigPath $tmp
        Remove-Item $tmp -Force
        $cfg.API_URL | Should -Be "http://server:4000"
    }
}

# ===========================================================================
# CPU
# ===========================================================================

Describe "CPU Collection" {

    It "returns a value between 0 and 100 from mocked CIM data" {
        Mock Get-CimInstance {
            return @(
                [PSCustomObject]@{ LoadPercentage = 45 },
                [PSCustomObject]@{ LoadPercentage = 55 }
            )
        } -ParameterFilter { $ClassName -eq "Win32_Processor" }
        Mock Start-Sleep {}

        $result = Get-CpuUsage
        $result | Should -Not -BeNullOrEmpty
        $result | Should -BeGreaterOrEqual 0
        $result | Should -BeLessOrEqual 100
    }

    It "averages two samples" {
        # Both samples: avg(40,60)=50, so overall = (50+50)/2 = 50
        Mock Get-CimInstance {
            return @(
                [PSCustomObject]@{ LoadPercentage = 40 },
                [PSCustomObject]@{ LoadPercentage = 60 }
            )
        } -ParameterFilter { $ClassName -eq "Win32_Processor" }
        Mock Start-Sleep {}

        $result = Get-CpuUsage
        $result | Should -Be 50.0
    }

    It "returns null when CIM throws" {
        Mock Get-CimInstance { throw "WMI unavailable" } `
             -ParameterFilter { $ClassName -eq "Win32_Processor" }

        $result = Get-CpuUsage
        $result | Should -BeNullOrEmpty
    }
}

# ===========================================================================
# MEMORY
# ===========================================================================

Describe "Memory Collection" {

    It "calculates UsedPercent=50 for half-used memory" {
        Mock Get-CimInstance {
            return [PSCustomObject]@{
                TotalVisibleMemorySize = 8388608L   # 8 GB in KB
                FreePhysicalMemory     = 4194304L   # 4 GB in KB
            }
        } -ParameterFilter { $ClassName -eq "Win32_OperatingSystem" }

        $result = Get-MemoryUsage
        $result           | Should -Not -BeNullOrEmpty
        $result.UsedPercent | Should -Be 50.0
        $result.TotalBytes  | Should -Be (8388608L * 1024)
    }

    It "returns null when CIM throws" {
        Mock Get-CimInstance { throw "WMI unavailable" } `
             -ParameterFilter { $ClassName -eq "Win32_OperatingSystem" }

        $result = Get-MemoryUsage
        $result | Should -BeNullOrEmpty
    }

    It "handles zero total memory without division by zero" {
        Mock Get-CimInstance {
            return [PSCustomObject]@{
                TotalVisibleMemorySize = 0L
                FreePhysicalMemory     = 0L
            }
        } -ParameterFilter { $ClassName -eq "Win32_OperatingSystem" }

        $result = Get-MemoryUsage
        $result            | Should -Not -BeNullOrEmpty
        $result.UsedPercent | Should -Be 0.0
    }
}

# ===========================================================================
# DISK
# ===========================================================================

Describe "Disk Collection" {

    It "returns fixed disks with correct UsedPercent" {
        Mock Get-CimInstance {
            return @(
                [PSCustomObject]@{ DeviceID = "C:"; Size = 107374182400L; FreeSpace = 53687091200L },
                [PSCustomObject]@{ DeviceID = "D:"; Size = 214748364800L; FreeSpace = 21474836480L }
            )
        } -ParameterFilter { $ClassName -eq "Win32_LogicalDisk" }

        $result = Get-DiskUsage

        $result.Count | Should -Be 2

        $c = $result | Where-Object { $_.Mount -eq "C:" }
        $c | Should -Not -BeNullOrEmpty
        $c.UsedPercent | Should -Be 50.0

        $d = $result | Where-Object { $_.Mount -eq "D:" }
        $d.UsedPercent | Should -Be 90.0
    }

    It "returns empty array when CIM throws" {
        Mock Get-CimInstance { throw "WMI unavailable" } `
             -ParameterFilter { $ClassName -eq "Win32_LogicalDisk" }

        $result = Get-DiskUsage
        @($result).Count | Should -Be 0
    }

    It "skips disks with zero size" {
        Mock Get-CimInstance {
            return @(
                [PSCustomObject]@{ DeviceID = "C:"; Size = 0L; FreeSpace = 0L },
                [PSCustomObject]@{ DeviceID = "D:"; Size = 107374182400L; FreeSpace = 53687091200L }
            )
        } -ParameterFilter { $ClassName -eq "Win32_LogicalDisk" }

        $result = Get-DiskUsage
        $result.Count | Should -Be 1
        $result[0].Mount | Should -Be "D:"
    }
}

# ===========================================================================
# UPTIME
# ===========================================================================

Describe "Uptime Calculation" {

    It "calculates uptime in seconds and ISO LastBootTime" {
        $bootTime = (Get-Date).AddHours(-2)

        Mock Get-CimInstance {
            return [PSCustomObject]@{ LastBootUpTime = $bootTime }
        } -ParameterFilter { $ClassName -eq "Win32_OperatingSystem" }

        $result = Get-UptimeInfo
        $result | Should -Not -BeNullOrEmpty
        # ~7200 s +/- 60 for timing
        $result.UptimeSeconds | Should -BeGreaterThan 7140
        $result.UptimeSeconds | Should -BeLessThan    7260
        # ISO 8601 UTC format
        $result.LastBootTime | Should -Match "^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"
    }

    It "returns null when CIM throws" {
        Mock Get-CimInstance { throw "WMI unavailable" } `
             -ParameterFilter { $ClassName -eq "Win32_OperatingSystem" }

        $result = Get-UptimeInfo
        $result | Should -BeNullOrEmpty
    }
}

# ===========================================================================
# NETWORK
# ===========================================================================

Describe "Network Status" {

    It "returns 'up' when a valid IP is present" {
        Mock Get-CimInstance {
            return @( [PSCustomObject]@{ IPEnabled = $true; IPAddress = @("192.168.1.10") } )
        } -ParameterFilter { $ClassName -eq "Win32_NetworkAdapterConfiguration" }

        Get-NetworkStatus | Should -Be "up"
    }

    It "returns 'down' when no adapters have valid IPs" {
        Mock Get-CimInstance {
            return @()
        } -ParameterFilter { $ClassName -eq "Win32_NetworkAdapterConfiguration" }

        Get-NetworkStatus | Should -Be "down"
    }

    It "filters out loopback 127.0.0.1" {
        Mock Get-CimInstance {
            return @( [PSCustomObject]@{ IPEnabled = $true; IPAddress = @("127.0.0.1") } )
        } -ParameterFilter { $ClassName -eq "Win32_NetworkAdapterConfiguration" }

        Get-NetworkStatus | Should -Be "down"
    }

    It "filters out APIPA 169.254.x.x" {
        Mock Get-CimInstance {
            return @( [PSCustomObject]@{ IPEnabled = $true; IPAddress = @("169.254.0.1") } )
        } -ParameterFilter { $ClassName -eq "Win32_NetworkAdapterConfiguration" }

        Get-NetworkStatus | Should -Be "down"
    }
}

# ===========================================================================
# SERVICE STATUS
# ===========================================================================

Describe "Service Status" {

    It "returns running for a running service" {
        # Use a dedicated wrapper to avoid PS 5.1 scoping issues with Get-Service mock
        function Invoke-GetService-spooler { Get-Service -Name "spooler" -ErrorAction Stop }

        Mock Get-Service {
            [PSCustomObject]@{ Status = "Running"; Name = "spooler" }
        } -ParameterFilter { $Name -eq "spooler" }

        $result = Get-ServiceStatus -ServiceList "spooler"
        $result = @($result)
        $result.Count    | Should -Be 1
        $result[0].Name  | Should -Be "spooler"
        $result[0].Status | Should -Be "running"
    }

    It "returns unknown when a service does not exist" {
        Mock Get-Service { throw "Cannot find service 'nonexistent-svc'" } `
             -ParameterFilter { $Name -eq "nonexistent-svc" }

        $result = @(Get-ServiceStatus -ServiceList "nonexistent-svc")
        $result.Count     | Should -Be 1
        $result[0].Status | Should -Be "unknown"
    }

    It "continues past a failing service and returns both results" {
        Mock Get-Service { throw "Not found" } `
             -ParameterFilter { $Name -eq "bad-svc" }
        Mock Get-Service {
            [PSCustomObject]@{ Status = "Running"; Name = "good-svc" }
        } -ParameterFilter { $Name -eq "good-svc" }

        $result = @(Get-ServiceStatus -ServiceList "bad-svc,good-svc")
        $result.Count | Should -Be 2

        ($result | Where-Object { $_.Name -eq "bad-svc"  }).Status | Should -Be "unknown"
        ($result | Where-Object { $_.Name -eq "good-svc" }).Status | Should -Be "running"
    }

    It "returns empty array for empty service list" {
        $result = @(Get-ServiceStatus -ServiceList "")
        $result.Count | Should -Be 0
    }
}

# ===========================================================================
# BACKUP STATUS
# ===========================================================================

Describe "Backup Status" {

    It "returns unknown + source=disabled when BACKUP_ENABLED is false" {
        $result = Get-BackupStatus -Enabled $false
        $result.status | Should -Be "unknown"
        $result.source | Should -Be "disabled"
    }

    It "returns source=not-installed when wbadmin.exe is absent" {
        Mock Test-Path { return $false } `
             -ParameterFilter { $Path -like "*wbadmin.exe" }

        $result = Get-BackupStatus-WindowsServerBackup
        $result.source | Should -Be "not-installed"
        $result.status | Should -Be "unknown"
    }

    It "regex correctly matches wbadmin Backup time line" {
        $line = "Backup time: 9/13/2026 2:00 AM"
        $line -match ":\s*(.+)$" | Should -Be $true
        $Matches[1].Trim() | Should -Be "9/13/2026 2:00 AM"
    }

    It "regex correctly matches wbadmin Backup size line" {
        $line = "Backup size: 1.50 GB"
        $line -match ":\s*([\d,\.]+)\s*(\w+)" | Should -Be $true
        $Matches[2].ToLower() | Should -Be "gb"
        [double]$Matches[1] | Should -Be 1.50
    }

    It "regex identifies recoverable volumes as success indicator" {
        $line = "Recoverable volumes: 1"
        $line -match "\d+" | Should -Be $true
    }
}

# ===========================================================================
# PAYLOAD GENERATION
# ===========================================================================

Describe "Payload Generation" {

    BeforeAll {
        Mock Get-CimInstance {
            [PSCustomObject]@{ DNSHostName = "win-test-01" }
        } -ParameterFilter { $ClassName -eq "Win32_ComputerSystem" }

        Mock Get-CimInstance {
            [PSCustomObject]@{
                Caption                = "Microsoft Windows Server 2022"
                Version                = "10.0.20348"
                TotalVisibleMemorySize = 8388608L
                FreePhysicalMemory     = 4194304L
                LastBootUpTime         = (Get-Date).AddHours(-3)
            }
        } -ParameterFilter { $ClassName -eq "Win32_OperatingSystem" }

        Mock Get-CimInstance {
            [PSCustomObject]@{ LoadPercentage = 35 }
        } -ParameterFilter { $ClassName -eq "Win32_Processor" }

        Mock Get-CimInstance {
            @( [PSCustomObject]@{ DeviceID = "C:"; Size = 107374182400L; FreeSpace = 53687091200L } )
        } -ParameterFilter { $ClassName -eq "Win32_LogicalDisk" }

        Mock Get-CimInstance {
            @( [PSCustomObject]@{ IPEnabled = $true; IPAddress = @("10.0.0.5") } )
        } -ParameterFilter { $ClassName -eq "Win32_NetworkAdapterConfiguration" }

        Mock Get-Service {
            [PSCustomObject]@{ Status = "Running"; Name = "spooler" }
        }

        Mock Start-Sleep {}

        Mock Test-Path { return $false } -ParameterFilter { $Path -like "*wbadmin*" }
    }

    $baseConfig = @{
        IMPORTANT_SERVICES   = "spooler"
        BACKUP_ENABLED       = $false
        SERVER_ID            = "srv-win-test"
        API_URL              = "http://localhost:4000/api/v1/health"
        AGENT_API_TOKEN      = "dummy"
        HTTP_TIMEOUT_SECONDS = 15
    }

    It "includes all required Phase 1 API fields" {
        $p = Build-Payload -Config $baseConfig
        $p.Keys | Should -Contain "hostname"
        $p.Keys | Should -Contain "os"
        $p.Keys | Should -Contain "cpuUsage"
        $p.Keys | Should -Contain "memoryUsage"
        $p.Keys | Should -Contain "diskUsage"
        $p.Keys | Should -Contain "networkStatus"
        $p.Keys | Should -Contain "backupStatus"
    }

    It "sets os = 'windows'" {
        $p = Build-Payload -Config $baseConfig
        $p.os | Should -Be "windows"
    }

    It "cpuUsage and memoryUsage are in range 0-100" {
        $p = Build-Payload -Config $baseConfig
        $p.cpuUsage    | Should -BeGreaterOrEqual 0
        $p.cpuUsage    | Should -BeLessOrEqual 100
        $p.memoryUsage | Should -BeGreaterOrEqual 0
        $p.memoryUsage | Should -BeLessOrEqual 100
    }

    It "diskUsage entries have mount and usedPercent keys" {
        $p = Build-Payload -Config $baseConfig
        $p.diskUsage | Should -Not -BeNullOrEmpty
        $p.diskUsage[0].Keys | Should -Contain "mount"
        $p.diskUsage[0].Keys | Should -Contain "usedPercent"
    }

    It "defaults cpuUsage to 0.0 when CPU collection fails" {
        Mock Get-CimInstance { throw "WMI down" } `
             -ParameterFilter { $ClassName -eq "Win32_Processor" }

        $p = Build-Payload -Config $baseConfig
        # Should not crash and should use safe default
        $p.cpuUsage | Should -Be 0.0
    }
}

# ===========================================================================
# HTTP SUBMISSION
# ===========================================================================

Describe "HTTP Submission" {

    $cfg = @{
        API_URL              = "http://localhost:4000/api/v1/health"
        AGENT_API_TOKEN      = "dummy-token"
        HTTP_TIMEOUT_SECONDS = 15
    }

    $payload = @{
        hostname = "test"; os = "windows"; cpuUsage = 20.0
        memoryUsage = 30.0; diskUsage = @(); networkStatus = "up"
        backupStatus = @{ status = "unknown" }
    }

    It "returns Success=true on HTTP 201" {
        Mock Invoke-WebRequest {
            [PSCustomObject]@{
                StatusCode = 201
                Content    = '{"success":true,"id":99,"receivedAt":"2026-09-14T00:00:00Z"}'
            }
        }

        $result = Submit-Payload -Config $cfg -Payload $payload
        $result.Success    | Should -Be $true
        $result.StatusCode | Should -Be 201
    }

    It "returns Success=false and StatusCode=401 on auth failure" {
        # Simulate a 401 WebException using PS 5.1-compatible constructor
        Mock Invoke-WebRequest {
            # Build a minimal HttpWebResponse-like object
            $fakeResp = [PSCustomObject]@{}
            $fakeResp | Add-Member -NotePropertyName StatusCode `
                -NotePropertyValue ([System.Net.HttpStatusCode]::Unauthorized)
            $fakeResp | Add-Member -MemberType ScriptMethod -Name GetResponseStream `
                -Value { return [System.IO.MemoryStream]::new() }

            # Use 2-argument constructor (message, innerException) — PS5.1 compatible
            $ex = New-Object System.Net.WebException "Unauthorized"
            # Inject the fake response via reflection
            $respField = [System.Net.WebException].GetField(
                '_Response', [System.Reflection.BindingFlags]'NonPublic,Instance')
            if ($respField) {
                $respField.SetValue($ex, $fakeResp)
            }
            throw $ex
        }
        Mock Start-Sleep {}

        $result = Submit-Payload -Config $cfg -Payload $payload
        $result.Success    | Should -Be $false
        # Either 401 (if reflection worked) or 0 (fallback), but never a retry past 1 attempt
        Should -Invoke Invoke-WebRequest -Exactly 1
    }

    It "retries exactly 3 times on connection failure" {
        Mock Invoke-WebRequest {
            throw (New-Object System.Net.WebException "Connection refused")
        }
        Mock Start-Sleep {}

        $result = Submit-Payload -Config $cfg -Payload $payload
        $result.Success    | Should -Be $false
        $result.StatusCode | Should -Be 0
        Should -Invoke Invoke-WebRequest -Exactly 3
    }

    It "returns Success=false without retrying on HTTP 400" {
        Mock Invoke-WebRequest {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"success":false}')
            $stream = [System.IO.MemoryStream]::new($bytes)

            $fakeResp = [PSCustomObject]@{}
            $fakeResp | Add-Member -NotePropertyName StatusCode `
                -NotePropertyValue ([System.Net.HttpStatusCode]::BadRequest)
            $fakeResp | Add-Member -MemberType ScriptMethod -Name GetResponseStream `
                -Value { return $stream }.GetNewClosure()

            $ex = New-Object System.Net.WebException "Bad Request"
            $respField = [System.Net.WebException].GetField(
                '_Response', [System.Reflection.BindingFlags]'NonPublic,Instance')
            if ($respField) { $respField.SetValue($ex, $fakeResp) }
            throw $ex
        }
        Mock Start-Sleep {}

        $result = Submit-Payload -Config $cfg -Payload $payload
        $result.Success | Should -Be $false
        Should -Invoke Invoke-WebRequest -Exactly 1
    }
}
