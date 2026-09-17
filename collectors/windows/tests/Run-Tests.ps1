<#
.SYNOPSIS
    Installs Pester if needed and runs the Windows collector test suite.

.DESCRIPTION
    Safe to run on any machine with PowerShell 5.1+ or pwsh 7+.
    Does NOT require a real Windows Server or live backend API.

.EXAMPLE
    pwsh -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
    # or from the windows/ directory:
    powershell -ExecutionPolicy Bypass -File .\tests\Run-Tests.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "[INFO] Windows Collector Test Runner" -ForegroundColor Cyan
Write-Host "[INFO] PowerShell version: $($PSVersionTable.PSVersion)"

# ---------------------------------------------------------------------------
# Ensure Pester 5.x is available
# ---------------------------------------------------------------------------
$minPesterVersion = [Version]"5.0.0"

$pester = Get-Module -ListAvailable -Name Pester |
          Where-Object { $_.Version -ge $minPesterVersion } |
          Sort-Object Version -Descending |
          Select-Object -First 1

if (-not $pester) {
    Write-Host "[INFO] Pester 5.x not found -- installing for current user..." -ForegroundColor Yellow
    try {
        Install-Module -Name Pester -MinimumVersion "5.0.0" -Force -Scope CurrentUser -SkipPublisherCheck
        Write-Host "[INFO] Pester installed successfully"
    }
    catch {
        Write-Host "[ERROR] Failed to install Pester: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "        Install manually: Install-Module Pester -MinimumVersion 5.0 -Force -Scope CurrentUser"
        exit 1
    }
}
else {
    Write-Host "[INFO] Found Pester $($pester.Version)"
}

Import-Module Pester -MinimumVersion "5.0.0" -Force

# ---------------------------------------------------------------------------
# Run the tests
# ---------------------------------------------------------------------------
$testFile = Join-Path $PSScriptRoot "collector.tests.ps1"

Write-Host "[INFO] Running: $testFile" -ForegroundColor Cyan
Write-Host ""

$config = New-PesterConfiguration
$config.Run.Path          = $testFile
$config.Output.Verbosity  = "Detailed"
$config.Run.Exit          = $false   # we handle exit code ourselves

$result = Invoke-Pester -Configuration $config

Write-Host ""
Write-Host ("=" * 60)
Write-Host "Test Results"
Write-Host ("=" * 60)
Write-Host ("  Tests run    : {0}" -f $result.TotalCount)
Write-Host ("  Passed       : {0}" -f $result.PassedCount)   -ForegroundColor Green
$failColor = if ($result.FailedCount -gt 0) { "Red" } else { "Green" }
Write-Host ("  Failed       : {0}" -f $result.FailedCount)   -ForegroundColor $failColor
Write-Host ("  Skipped      : {0}" -f $result.SkippedCount)
Write-Host ("=" * 60)

if ($result.FailedCount -gt 0) {
    Write-Host "[FAIL] $($result.FailedCount) test(s) failed." -ForegroundColor Red
    exit 1
}
else {
    Write-Host "[PASS] All $($result.PassedCount) tests passed." -ForegroundColor Green
    exit 0
}
