//! Per-user Windows Task Scheduler registration. No administrator or stored account password.
#[tauri::command]
pub async fn background_backup_task(enabled: Option<bool>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || run(enabled)).await.map_err(|e| e.to_string())?
}
fn run(enabled: Option<bool>) -> Result<bool, String> {
    #[cfg(not(target_os = "windows"))]
    { let _ = enabled; Err("Background backup tasks are supported on Windows only".into()) }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_str().ok_or("Unsupported executable path")?.replace('\'', "''");
        let action = match enabled {
            Some(true) => format!(r#"
$action = New-ScheduledTaskAction -Execute '{exe}' -Argument '--backup-if-due'
$hourly = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $sid
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($hourly,$logon) -Principal $principal -Settings $settings -Description 'Project NOU: check the opted-in weekly backup schedule while this user is signed in.' -Force | Out-Null
"#),
            Some(false) => "if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }".into(),
            None => String::new(),
        };
        let script = format!(r#"$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = 'ProjectNOU-Backup-' + $sid
{action}
$exists = $null -ne (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)
$exists | ConvertTo-Json -Compress
"#);
        let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).creation_flags(0x08000000).output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(format!("Windows backup task could not be changed or inspected: {}", String::from_utf8_lossy(&output.stderr).trim())); }
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Cannot read Windows task status: {e}"))
    }
}
