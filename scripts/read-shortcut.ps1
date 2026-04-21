$s = (New-Object -ComObject WScript.Shell).CreateShortcut('C:\Users\WD\Desktop\WAT321 Test Instance.lnk')
Write-Output ('Target: ' + $s.TargetPath)
Write-Output ('Args: ' + $s.Arguments)
Write-Output ('WorkingDir: ' + $s.WorkingDirectory)
