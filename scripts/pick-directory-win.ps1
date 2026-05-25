$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Complete-WithPath {
  param([string] $SelectedPath)

  if (-not [string]::IsNullOrWhiteSpace($SelectedPath)) {
    [Console]::Out.WriteLine($SelectedPath)
    exit 0
  }
}

function Open-WinFormsFolderDialog {
  Add-Type -AssemblyName System.Windows.Forms

  $owner = New-Object System.Windows.Forms.Form
  $owner.Text = "Выбор репозитория"
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Width = 1
  $owner.Height = 1
  $owner.Opacity = 0

  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Выберите путь к репозиторию"
  $dialog.ShowNewFolderButton = $false

  try {
    $null = $owner.Show()
    $owner.Activate()
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

function Open-ShellFolderDialog {
  $shell = New-Object -ComObject Shell.Application
  $returnOnlyFileSystemDirs = 0x0001
  $newDialogStyle = 0x0040
  $computerRoot = 17
  $folder = $shell.BrowseForFolder(
    0,
    "Выберите путь к репозиторию",
    ($returnOnlyFileSystemDirs -bor $newDialogStyle),
    $computerRoot
  )

  if ($null -ne $folder) {
    Complete-WithPath $folder.Self.Path
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
