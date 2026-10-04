#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Bump package versions following semver policy (patch-only by default).

.DESCRIPTION
    Increments the PATCH segment of version numbers in all package.json files.
    MAJOR and MINOR bumps require explicit flags (--minor or --major).

.PARAMETER Type
    Version segment to bump: "patch" (default), "minor", or "major"

.PARAMETER Set
    Set an exact version instead of incrementing (e.g., "1.0.0")

.EXAMPLE
    .\scripts\bump-version.ps1
    # 0.5.0 -> 0.5.1

.EXAMPLE
    .\scripts\bump-version.ps1 -Type minor
    # 0.5.1 -> 0.6.0

.EXAMPLE
    .\scripts\bump-version.ps1 -Set "1.0.0"
    # Sets all packages to exactly 1.0.0
#>

param(
    [ValidateSet("patch", "minor", "major")]
    [string]$Type = "patch",
    
    [string]$Set = ""
)

$ErrorActionPreference = "Stop"

# Project root
$RootDir = Split-Path -Parent $PSScriptRoot

# Single all-in-one package: dsh-connect carries the core service, every channel
# adapter, and the web-settings stack.
$PackageFiles = @(
    "packages\connect\package.json"
)

function Parse-SemVer {
    param([string]$Version)
    
    if ($Version -match '^(\d+)\.(\d+)\.(\d+)(-.+)?$') {
        return @{
            Major = [int]$Matches[1]
            Minor = [int]$Matches[2]
            Patch = [int]$Matches[3]
            Prerelease = $Matches[4]
        }
    }
    throw "Invalid semver format: $Version (expected MAJOR.MINOR.PATCH)"
}

function Format-SemVer {
    param(
        [int]$Major,
        [int]$Minor,
        [int]$Patch,
        [string]$Prerelease = ""
    )
    
    $version = "$Major.$Minor.$Patch"
    if ($Prerelease) {
        $version += $Prerelease
    }
    return $version
}

function Update-PackageVersion {
    param(
        [string]$FilePath,
        [string]$NewVersion
    )

    if (-not (Test-Path $FilePath)) {
        Write-Warning "File not found: $FilePath"
        return $false
    }
    $FilePath = (Resolve-Path -LiteralPath $FilePath).Path

    # Text surgery, deliberately — NOT `ConvertFrom-Json | ConvertTo-Json`.
    #
    # A round trip re-emits the whole document: 4-space indents, CRLF endings,
    # double spaces after every colon, & for every `&`. Worse, it cannot be
    # written back by `Set-Content -Encoding UTF8`, which on Windows PowerShell
    # 5.1 means "UTF-8 *with BOM*". DSH parses plugin manifests with a strict
    # JSON parser, and a manifest starting EF BB BF makes it drop the plugin
    # outright ("skipping profile bundle ... is not valid JSON") — the package
    # looks published and simply never loads. That is how 1.0.2 was nearly
    # shipped broken, so this function no longer goes near that pair.
    #
    # Instead: find the one top-level `"version"` line, replace the value inside
    # it, and write the original bytes back. In the whole-file regex the `^`
    # anchor (with the multiline option) is what keeps this from touching a
    # nested `"version"`; every manifest here has exactly one at the top level.
    $Content = [System.IO.File]::ReadAllText($FilePath)
    $Pattern = '(?m)^(\s*"version"\s*:\s*")[^"]*(")'
    $Regex = New-Object System.Text.RegularExpressions.Regex($Pattern)
    $Match = $Regex.Match($Content)
    if (-not $Match.Success) {
        Write-Warning "No top-level ""version"" line found in $FilePath"
        return $false
    }
    $OldVersion = $Match.Groups[0].Value -replace '^.*"([^"]*)".*$', '$1'

    # `${1}`/`${2}` are the anchors above; only the middle is new text. The
    # escaping exists so a `$` in a version string can never be read as a
    # backreference by the regex engine.
    $Replacement = '${1}' + ($NewVersion -replace '\$', '$$') + '${2}'
    $Updated = $Regex.Replace($Content, $Replacement, 1)

    # Validate before writing, so a bad replacement cannot leave a broken
    # manifest on disk with the old one already gone.
    $null = $Updated | ConvertFrom-Json

    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($FilePath, $Updated, $Utf8NoBom)

    Write-Host "  ✓ $FilePath : $OldVersion → $NewVersion"
    return $true
}

try {
    Write-Host "`n📦 dsh-connect Version Bump" -ForegroundColor Cyan
    Write-Host ("=" * 50)
    
    # Read current version from first package
    $FirstPackage = Join-Path $RootDir $PackageFiles[0]
    $CurrentJson = Get-Content $FirstPackage -Raw -Encoding UTF8 | ConvertFrom-Json
    $CurrentVersion = $CurrentJson.version
    
    Write-Host "Current version: $CurrentVersion" -ForegroundColor Yellow
    
    if ($Set) {
        # Set exact version
        $NewVersion = $Set
        Write-Host "Setting exact version: $NewVersion" -ForegroundColor Green
    } else {
        # Increment based on type
        $SemVer = Parse-SemVer $CurrentVersion
        
        switch ($Type) {
            "patch" {
                $SemVer.Patch++
                Write-Host "Bumping PATCH: $($SemVer.Major).$($SemVer.Minor).$($SemVer.Patch - 1) → $($SemVer.Major).$($SemVer.Minor).$($SemVer.Patch)" -ForegroundColor Green
            }
            "minor" {
                $SemVer.Minor++
                $SemVer.Patch = 0
                Write-Host "Bumping MINOR: $($SemVer.Major).$($SemVer.Minor - 1).X → $($SemVer.Major).$($SemVer.Minor).0" -ForegroundColor Green
            }
            "major" {
                $SemVer.Major++
                $SemVer.Minor = 0
                $SemVer.Patch = 0
                Write-Host "Bumping MAJOR: $($SemVer.Major - 1).X.X → $($SemVer.Major).0.0" -ForegroundColor Green
            }
        }
        
        $NewVersion = Format-SemVer -Major $SemVer.Major -Minor $SemVer.Minor -Patch $SemVer.Patch -Prerelease $SemVer.Prerelease
    }
    
    # Update all package files
    $SuccessCount = 0
    foreach ($PackageFile in $PackageFiles) {
        $FullPath = Join-Path $RootDir $PackageFile
        if (Update-PackageVersion -FilePath $FullPath -NewVersion $NewVersion) {
            $SuccessCount++
        }
    }
    
    Write-Host ("=" * 50)
    Write-Host "✅ Updated $SuccessCount/$($PackageFiles.Count) packages to v$NewVersion" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Review changes: git diff"
    Write-Host "  2. Commit: git commit -m `"chore: bump version to $NewVersion`""
    Write-Host "  3. Tag: git tag v$NewVersion && git push origin v$NewVersion"
    Write-Host "  4. Publish: create a GitHub Release for v$NewVersion — .github/workflows/publish.yml builds, typechecks, tests and publishes the single dsh-connect package automatically."
    Write-Host "     Manual alternative:"
    Write-Host "     cd packages/connect && npm publish"
    Write-Host ""
    
} catch {
    Write-Host "❌ Error: $_" -ForegroundColor Red
    exit 1
}
