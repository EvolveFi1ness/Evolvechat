# ── AUTO-PUSH WATCHER ──────────────────────────────────
# Watches for file changes and auto-commits + pushes to GitHub.
# Run:  .\auto-push.ps1
# Stop: Ctrl+C

$repoPath = $PSScriptRoot
if (-not $repoPath) { $repoPath = Get-Location }

Set-Location $repoPath

# Debounce: wait this many ms after the last change before committing
$debounceMs = 2000

Write-Host ""
Write-Host "  Evolve Auto-Push Watcher" -ForegroundColor Cyan
Write-Host "  Watching: $repoPath" -ForegroundColor DarkGray
Write-Host "  Debounce: ${debounceMs}ms" -ForegroundColor DarkGray
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

# Make an initial commit if the repo is empty
$hasCommits = git log --oneline -1 2>$null
if (-not $hasCommits) {
    Write-Host "  [INIT] Making initial commit..." -ForegroundColor Yellow
    git add -A
    git commit -m "Initial commit"
    git push -u origin main 2>$null
    if ($LASTEXITCODE -ne 0) { git push -u origin master 2>$null }
    Write-Host "  [INIT] Done." -ForegroundColor Green
}

# Set up file watcher
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $repoPath
$watcher.IncludeSubdirectories = $true
$watcher.Filter = "*.*"
$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor
                        [System.IO.NotifyFilters]::FileName -bor
                        [System.IO.NotifyFilters]::DirectoryName

# Ignore .git folder and node_modules
$watcher.Filter = "*.*"

$timer = $null
$changes = [System.Collections.Generic.List[string]]::new()

$onChanged = {
    $path = $Event.SourceEventArgs.FullPath
    $name = $Event.SourceEventArgs.Name
    # Skip .git internals and node_modules
    if ($path -match '\\\.git\\' -or $path -match '\\node_modules\\' -or $name -eq 'auto-push.ps1') { return }
    $changes.Add($path)
}

$onCreated = $onChanged
$onRenamed = {
    $path = $Event.SourceEventArgs.FullPath
    if ($path -match '\\\.git\\' -or $path -match '\\node_modules\\') { return }
    $changes.Add($path)
}

Register-ObjectEvent $watcher "Changed" -Action $onChanged
Register-ObjectEvent $watcher "Created" -Action $onCreated
Register-ObjectEvent $watcher "Renamed" -Action $onRenamed
Register-ObjectEvent $watcher "Deleted" -Action $onChanged

$watcher.EnableRaisingEvents = $true

Write-Host "  Watching for changes..." -ForegroundColor Green
Write-Host ""

try {
    while ($true) {
        if ($changes.Count -gt 0) {
            Start-Sleep -Milliseconds $debounceMs

            # Grab all pending changes
            $pending = $changes.ToArray()
            $changes.Clear()

            # Count unique files
            $files = $pending | Sort-Object -Unique
            $count = $files.Count

            $timestamp = Get-Date -Format "HH:mm:ss"
            Write-Host ""
            Write-Host "  [$timestamp] $count file(s) changed — staging..." -ForegroundColor Yellow

            git add -A
            $status = git status --porcelain
            if ($status) {
                # Build a short summary of what changed
                $added = ($status | Select-String '^\?\?').Count
                $modified = ($status | Select-String '^ ?M').Count
                $deleted = ($status | Select-String '^ ?D').Count

                $parts = @()
                if ($added -gt 0)    { $parts += "$added added" }
                if ($modified -gt 0) { $parts += "$modified modified" }
                if ($deleted -gt 0)  { $parts += "$deleted deleted" }
                $summary = $parts -join ", "

                # Show what's about to be committed
                Write-Host ""
                Write-Host "  Changes to commit:" -ForegroundColor Cyan
                Write-Host "  -------------------" -ForegroundColor DarkGray
                $status | ForEach-Object {
                    $line = $_.Trim()
                    if ($line -match '^\?\?\s+(.+)$') {
                        Write-Host "    [NEW]    $($Matches[1])" -ForegroundColor Green
                    } elseif ($line -match '^.M\s+(.+)$') {
                        Write-Host "    [EDIT]   $($Matches[1])" -ForegroundColor Yellow
                    } elseif ($line -match '^.D\s+(.+)$') {
                        Write-Host "    [DEL]    $($Matches[1])" -ForegroundColor Red
                    } elseif ($line -match '^.R\s+.+\s+->\s+(.+)$') {
                        Write-Host "    [REN]    $($Matches[1])" -ForegroundColor Magenta
                    } else {
                        Write-Host "    [CHANGE] $line" -ForegroundColor DarkYellow
                    }
                }
                Write-Host "  -------------------" -ForegroundColor DarkGray
                Write-Host "  Total: $summary" -ForegroundColor White

                # Show diff stats (line-level summary)
                $diffStat = git diff --staged --stat 2>$null
                if ($diffStat) {
                    Write-Host ""
                    Write-Host "  Diff summary:" -ForegroundColor Cyan
                    $diffStat | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
                }

                # Ask for review
                Write-Host ""
                $confirm = Read-Host "  Push to GitHub? [Y/n]"
                if ($confirm -eq '' -or $confirm -eq 'y' -or $confirm -eq 'Y') {
                    $msg = "Auto-push: $summary"
                    git commit -m $msg 2>$null | Out-Null

                    $pushResult = git push 2>&1
                    if ($LASTEXITCODE -eq 0) {
                        Write-Host "  [$timestamp] Pushed: $msg" -ForegroundColor Green
                    } else {
                        Write-Host "  [$timestamp] Push failed: $pushResult" -ForegroundColor Red
                    }
                } else {
                    Write-Host "  [$timestamp] Skipped — changes unstaged" -ForegroundColor DarkGray
                    git reset HEAD 2>$null | Out-Null
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    Get-EventSubscriber | Unregister-Event
    Write-Host "`n  Watcher stopped." -ForegroundColor DarkGray
}
