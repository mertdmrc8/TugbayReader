$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$build = New-Item -ItemType Directory -Force (Join-Path $root 'build')
$stage = New-Item -ItemType Directory (Join-Path $build.FullName ([guid]::NewGuid().ToString('N')))
$payload = New-Item -ItemType Directory (Join-Path $stage.FullName 'payload')
$runtime = New-Item -ItemType Directory (Join-Path $payload.FullName 'runtime')
$pythonArchive = Join-Path $stage.FullName 'python.zip'
Invoke-WebRequest 'https://www.python.org/ftp/python/3.13.17/python-3.13.17-embed-amd64.zip' -OutFile $pythonArchive
if ((Get-FileHash -LiteralPath $pythonArchive -Algorithm SHA256).Hash -ne '9E35319BFFEDAB8B36AD44D8F377CB4F1733BCEC257A0B6D04D94F01486DDB38') {
    throw 'Python arşivi doğrulanamadı.'
}
Expand-Archive -LiteralPath $pythonArchive -DestinationPath $runtime.FullName
python -m pip install --only-binary=:all: --no-deps --platform win_amd64 --implementation cp --python-version 3.13 --abi cp313 --target $runtime.FullName 'PyMuPDF==1.28.2'
if ($LASTEXITCODE -ne 0) { throw 'PDF motoru yüklenemedi.' }

$files = 'app.py', 'app.js', 'index.html', 'style.css', 'TugbayReader.cmd', 'TugbayReader.ico', 'TugbayReader.png', 'tessdata', 'LICENSE', 'README.md'
foreach ($file in $files) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination $payload.FullName -Recurse
}
$archive = Join-Path $stage.FullName 'TugbayReader.zip'
Compress-Archive -Path (Join-Path $payload.FullName '*') -DestinationPath $archive
$setup = Join-Path $build.FullName 'TugbayReader-Kurulum.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$icon = Join-Path $root 'TugbayReader.ico'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 /reference:System.Windows.Forms.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll /reference:Microsoft.CSharp.dll "/win32icon:$icon" "/resource:$archive,TugbayReader.zip" "/out:$setup" (Join-Path $PSScriptRoot 'Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'Kurucu derlenemedi.' }
Write-Output $setup
