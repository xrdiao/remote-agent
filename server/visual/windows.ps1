[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VisualWindows {
  public delegate bool Callback(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
$rows = [System.Collections.Generic.List[object]]::new()
$callback = [VisualWindows+Callback]{ param($hwnd, $data)
  if ([VisualWindows]::IsWindowVisible($hwnd)) {
    $text = [System.Text.StringBuilder]::new(1024)
    [void][VisualWindows]::GetWindowText($hwnd, $text, $text.Capacity)
    [uint32]$windowPid = 0
    [void][VisualWindows]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
    $process = Get-Process -Id $windowPid -ErrorAction SilentlyContinue
    if ($text.Length -gt 0) { $rows.Add(@{id=$hwnd.ToInt64().ToString();title=$text.ToString();process=$process.ProcessName}) }
  }
  return $true
}
[void][VisualWindows]::EnumWindows($callback, [IntPtr]::Zero)
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress
