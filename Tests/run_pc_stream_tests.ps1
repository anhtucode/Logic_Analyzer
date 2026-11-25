param([switch]$SkipWeb)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$includePaths = @('Core/Inc','Drivers/STM32F1xx_HAL_Driver/Inc',
  'Drivers/CMSIS/Device/ST/STM32F1xx/Include','Drivers/CMSIS/Include',
  'USB_DEVICE/App','USB_DEVICE/Target','Middlewares/ST/STM32_USB_Device_Library/Core/Inc',
  'Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc')
$compilerFlags = @('-std=c99','-O2','-flto','-Wall','-Wextra','-Werror',
  '-Wno-pointer-to-int-cast','-Wno-int-to-pointer-cast','-ffunction-sections',
  '-fdata-sections','-DUSE_HAL_DRIVER','-DSTM32F103xB')
Push-Location $projectPath
try {
  $includeFlags = $includePaths | ForEach-Object { '-I' + $_ }
  foreach ($testName in @('test_pc_stream','test_lcd_stream','test_lcd_init')) {
    $testBinary = Join-Path $env:TEMP ($testName + '.exe')
    & gcc @compilerFlags @includeFlags "Tests/$testName.c" Core/Src/lcd_mode.c '-Wl,--gc-sections' -o $testBinary
    if ($LASTEXITCODE -ne 0) { throw "Compile failed: $testName" }
    & $testBinary
    if ($LASTEXITCODE -ne 0) { throw "Test failed: $testName" }
  }
  if (!$SkipWeb) {
    & node Tests/test_protocol_decoders.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Protocol decoder test failed' }
    & node Tests/test_pc_stream_web.cjs
    if ($LASTEXITCODE -ne 0) { throw 'AppWeb stream test failed' }
    & node Tests/test_analysis.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Analysis core test failed' }
    & node Tests/test_workbench.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Workbench runtime test failed' }
  }
} finally { Pop-Location }
