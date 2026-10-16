using System;
using System.Diagnostics;
using System.IO;

class Program {
  static int Main() {
    string tools = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    string repo = Directory.GetParent(tools).FullName;
    string script = Path.Combine(tools, "pair-link.mjs");
    if (!File.Exists(script)) {
      Console.Error.WriteLine("找不到 pair-link.mjs，请把本程序放在仓库的 window_start 目录。");
      return 1;
    }
    string node = FindNode(repo);
    var psi = new ProcessStartInfo {
      FileName = node,
      Arguments = "\"" + script + "\"",
      WorkingDirectory = tools,
      UseShellExecute = false,
    };
    using (var p = Process.Start(psi)) {
      if (p == null) {
        Console.Error.WriteLine("无法启动 Node。请安装 Node.js 22+，或把便携 Node 放在仓库 .runtime 下。");
        return 1;
      }
      p.WaitForExit();
      int code = p.ExitCode;
      Console.WriteLine();
      if (code != 0) Console.WriteLine("启动中继、隧道或生成配对链接失败，请看上方提示。");
      return code;
    }
  }

  // Prefer PATH, then any .runtime/node*/node.exe (no hard-coded version folder).
  static string FindNode(string repoRoot) {
    try {
      var where = new ProcessStartInfo {
        FileName = "where.exe",
        Arguments = "node",
        UseShellExecute = false,
        RedirectStandardOutput = true,
        CreateNoWindow = true,
      };
      using (var p = Process.Start(where)) {
        string line = p.StandardOutput.ReadLine();
        p.WaitForExit();
        if (!string.IsNullOrWhiteSpace(line) && File.Exists(line.Trim())) return line.Trim();
      }
    } catch { }

    string runtime = Path.Combine(repoRoot, ".runtime");
    if (Directory.Exists(runtime)) {
      foreach (var dir in Directory.GetDirectories(runtime)) {
        string name = Path.GetFileName(dir);
        if (name.StartsWith("node", StringComparison.OrdinalIgnoreCase)) {
          string cand = Path.Combine(dir, "node.exe");
          if (File.Exists(cand)) return cand;
        }
      }
    }
    return "node";
  }
}
