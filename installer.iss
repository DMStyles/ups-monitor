; UPS Power Monitor — Inno Setup Script
; Creates a professional Windows installer for v2.0.0
; -------------------------------------------------------

#define MyAppName "UPS Power Monitor"
#define MyAppVersion "2.0.44"
#define MyAppPublisher "DMStyles"
#define MyAppURL "https://github.com/DMStyles/ups-monitor"
#define MyAppExeName "UPS Power Monitor.exe"
#define MyAppDir "dist\UPS Power Monitor"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
AllowNoIcons=yes
LicenseFile=LICENSE
OutputDir=release
OutputBaseFilename=UPS-Power-Monitor-Setup-v{#MyAppVersion}
SetupIconFile=static\favicon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=120
DisableProgramGroupPage=yes
; Run as admin to install to Program Files
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
; Windows 10 minimum
MinVersion=10.0.17763

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "Start UPS Power Monitor when Windows starts"; GroupDescription: "Startup Options:"

[Files]
; Bundle all PyInstaller output files
Source: "{#MyAppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
Name: "{autoprograms}\{#MyAppName}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Registry]
; Add to autostart if user chose that option
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: """{app}\{#MyAppExeName}"""; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Launch the app after install
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall

[UninstallRun]
; Kill any running instances before uninstall
Filename: "taskkill"; Parameters: "/f /im ""{#MyAppExeName}"""; Flags: runhidden; RunOnceId: "KillApp"

[Code]
// Check if WebView2 Runtime is installed (required by pywebview)
function IsWebView2Installed(): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'pv', Version) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'pv', Version);
end;

procedure InitializeWizard();
begin
  if not IsWebView2Installed() then
  begin
    MsgBox(
      'Microsoft Edge WebView2 Runtime is not installed.' + #13#10 + #13#10 +
      'UPS Power Monitor requires WebView2 to display its interface.' + #13#10 +
      'Please install it from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/' + #13#10 + #13#10 +
      'The installer will continue, but you may need to install WebView2 before the app works.',
      mbInformation, MB_OK
    );
  end;
end;

