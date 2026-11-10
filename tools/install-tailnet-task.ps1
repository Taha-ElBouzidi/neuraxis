$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe).Source
$script = Join-Path $PSScriptRoot 'tailnet-sweep.mjs'
$name = 'HavokTailnetUp'
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Brain server: bind a new tailnet address when a network connects (tools/tailnet-sweep.mjs)</Description></RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"&gt;&lt;Select Path="Microsoft-Windows-NetworkProfile/Operational"&gt;*[System[(EventID=10000)]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
    </EventTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>conhost.exe</Command><Arguments>--headless "$node" "$script"</Arguments></Exec>
  </Actions>
</Task>
"@
Register-ScheduledTask -TaskName $name -Xml $xml -Force | Out-Null
Set-Content -Path (Join-Path (Split-Path $PSScriptRoot -Parent) '.tailnet-event') -Value "task $name registered $((Get-Date).ToUniversalTime().ToString('s'))Z" -Encoding ascii
Write-Output "registered $name; the brain server runs no tailnet timer from its next start"
