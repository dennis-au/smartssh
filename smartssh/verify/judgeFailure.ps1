function Get-JudgeFailureLines {
    param([string[]] $Lines = @())

    $reasons = [ordered]@{}
    $fallback = ''
    foreach ($raw in $Lines) {
        $line = ([string]$raw).Trim()
        if (-not $line) { continue }
        if ($line -notmatch '^(?:\d+ pass / \d+ fail / \d+ skipped$|live measurements:)') {
            $fallback = $line
        }

        if ($line -match '^JUDGE FAIL:\s*(.*)$') {
            $reason = $Matches[1].Trim()
            if ($reason) { $reasons[$reason] = $reason }
        } elseif ($line -match '^(?:FAIL|metrics invalid:|cannot read metrics:|exe sha256|--exe-sha)') {
            # The judge repeats each table failure as JUDGE FAIL; prefer that explicit reason.
            $key = $line -replace '^FAIL\s+', ''
            if (-not $reasons.Contains($key)) { $reasons[$key] = $line }
        }
    }

    if ($reasons.Count) { return $reasons.Values }
    if ($fallback) { return $fallback }
    return 'judge produced no output'
}
