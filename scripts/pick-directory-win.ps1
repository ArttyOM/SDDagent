$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Complete-WithPath {
  param([string] $SelectedPath)

  if (-not [string]::IsNullOrWhiteSpace($SelectedPath)) {
    [Console]::Out.WriteLine($SelectedPath)
    exit 0
  }
}

function Open-ShellFolderDialog {
  $shell = New-Object -ComObject Shell.Application
  $returnOnlyFileSystemDirs = 0x0001
  $newDialogStyle = 0x0040
  $computerRoot = 17
  $folder = $shell.BrowseForFolder(
    0,
    "Select repository folder",
    ($returnOnlyFileSystemDirs -bor $newDialogStyle),
    $computerRoot
  )

  if ($null -ne $folder) {
    Complete-WithPath $folder.Self.Path
  }
}

function Open-WinFormsFolderDialog {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $owner = New-Object System.Windows.Forms.Form
  $owner.Text = "Repository folder"
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.Size = New-Object System.Drawing.Size(320, 90)
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
  $owner.ShowInTaskbar = $true
  $owner.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Select repository folder..."
  $label.Dock = [System.Windows.Forms.DockStyle]::Fill
  $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $owner.Controls.Add($label)

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Select repository folder"
  $dialog.ShowNewFolderButton = $false

  try {
    $owner.Show()
    $owner.Activate()
    $owner.BringToFront()
    $result = $dialog.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      Complete-WithPath $dialog.SelectedPath
    }
  }
  finally {
    $dialog.Dispose()
    $owner.Close()
    $owner.Dispose()
  }
}

try {
  Open-WinFormsFolderDialog
}
catch {
  try {
    Open-ShellFolderDialog
  }
  catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
  }
}

exit 2
