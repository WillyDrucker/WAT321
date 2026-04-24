# WAT321 Epic Handshake - Stage Clipboard Image
#
# Writes whatever image is on the Windows clipboard to a PNG file
# under ~/.wat321/epic-handshake/attachments/clipboard/ and prints
# the absolute path to stdout. Exits 1 with a friendly stderr message
# if the clipboard has no image.
#
# Usage:
#   powershell -NoProfile -NonInteractive -File stage-clipboard.ps1
#   powershell -NoProfile -NonInteractive -File stage-clipboard.ps1 -OutPath "C:\some\path\image.png"
#
# Called by Claude via Bash when the user has pasted a screenshot and
# wants Codex to see it. The printed path goes into `file_paths` on the
# epic_handshake_ask tool so Codex reads the image directly from disk.
# Image bytes never enter Claude's token budget.

param(
  [string]$OutPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($OutPath)) {
  $stagingDir = Join-Path $HOME ".wat321\epic-handshake\attachments\clipboard"
  if (-not (Test-Path $stagingDir)) {
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
  }
  $ts = (Get-Date).ToString("yyyy-MM-ddTHH-mm-ss-fffZ")
  $OutPath = Join-Path $stagingDir "clipboard-$ts.png"
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  [Console]::Error.WriteLine("stage-clipboard: no image on the clipboard")
  exit 1
}

$image.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output $OutPath
