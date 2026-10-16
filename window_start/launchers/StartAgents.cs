using System;
using System.Diagnostics;
using System.IO;

class Program {
  static int Main() {
    string tools = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    string ps1 = Path.Combine(tools, "start-agents.ps1");
    if (!File.Exists(ps1)) {
      Console.Error.WriteLine("找不到 start-agents.ps1，请把本程序放在仓库的 window_start 目录。");
      return 1;
    }
    var psi = new ProcessStartInfo {
      FileName = "powershell.exe",
      Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + ps1 + "\"",
      WorkingDirectory = tools,
      UseShellExecute = true,
      WindowStyle = ProcessWindowStyle.Normal,
    };
    using (var p = Process.Start(psi)) {
      if (p == null) {
        Console.Error.WriteLine("无法启动 PowerShell。");
        return 1;
      }
      return 0;
    }
  }
}
