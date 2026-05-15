$shortcutPath = Join-Path $env:USERPROFILE "Desktop\WAT321 Test Instance.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
Write-Output ('Target: ' + $s.TargetPath)
Write-Output ('Args: ' + $s.Arguments)
Write-Output ('WorkingDir: ' + $s.WorkingDirectory)
