$ErrorActionPreference = 'Stop'

$root = Resolve-Path $PSScriptRoot
$packageJson = Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json
$id = $packageJson.name
$version = $packageJson.version
$publisher = $packageJson.publisher
$displayName = [System.Security.SecurityElement]::Escape($packageJson.displayName)
$description = [System.Security.SecurityElement]::Escape($packageJson.description)
$engine = [System.Security.SecurityElement]::Escape($packageJson.engines.vscode)
$outFile = Join-Path $root "$id-$version.vsix"
$temp = Join-Path $root ".vsix-build-$PID"
$extensionDir = Join-Path $temp 'extension'

$resolvedTempParent = [System.IO.Path]::GetFullPath($temp)
$resolvedRoot = [System.IO.Path]::GetFullPath($root)
if (-not $resolvedTempParent.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to remove a path outside the project: $resolvedTempParent"
}

if (Test-Path -LiteralPath $outFile) {
  try {
    Remove-Item -Force -LiteralPath $outFile
  } catch {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $outFile = Join-Path $root "$id-$version-$stamp.vsix"
    Write-Warning "Could not replace existing VSIX; writing $outFile instead."
  }
}

New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null
Copy-Item -Recurse -Force -LiteralPath (Join-Path $root 'src') -Destination $extensionDir
Copy-Item -Recurse -Force -LiteralPath (Join-Path $root 'media') -Destination $extensionDir
Copy-Item -Force -LiteralPath (Join-Path $root 'package.json') -Destination $extensionDir
Copy-Item -Force -LiteralPath (Join-Path $root 'README.md') -Destination (Join-Path $extensionDir 'readme.md')
Copy-Item -Force -LiteralPath (Join-Path $root 'LICENSE.txt') -Destination $extensionDir

$contentTypes = @'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="ps1" ContentType="text/plain" />
</Types>
'@

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$id" Version="$version" Publisher="$publisher" />
    <DisplayName>$displayName</DisplayName>
    <Description xml:space="preserve">$description</Description>
    <Tags>pdf,translation,viewer</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$engine" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
"@

Set-Content -LiteralPath (Join-Path $temp '[Content_Types].xml') -Value $contentTypes -Encoding UTF8
Set-Content -LiteralPath (Join-Path $temp 'extension.vsixmanifest') -Value $manifest -Encoding UTF8

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($temp, $outFile)
try {
  Remove-Item -Recurse -Force -LiteralPath $temp
} catch {
  Write-Warning "VSIX was created, but temporary directory cleanup failed: $($_.Exception.Message)"
}

Write-Output $outFile
