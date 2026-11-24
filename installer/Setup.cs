using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

static class Setup
{
    [STAThread]
    static int Main()
    {
        string testRoot = Environment.GetEnvironmentVariable("TUGBAY_INSTALL_TEST_ROOT");
        try
        {
            bool testing = !String.IsNullOrWhiteSpace(testRoot);
            string programs = testing ? Path.Combine(testRoot, "Programs") :
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "TugbayReader");
            string desktop = testing ? Path.Combine(testRoot, "Desktop") :
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            string menu = testing ? Path.Combine(testRoot, "StartMenu") :
                Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            string install = Path.Combine(programs, "14.1.2");
            string runtime = Path.Combine(install, "runtime", "pythonw.exe");
            string app = Path.Combine(install, "app.py");
            string icon = Path.Combine(install, "TugbayReader.ico");
            if (!File.Exists(runtime) || !File.Exists(app) || !File.Exists(icon))
            {
                string stage = Path.Combine(programs, "install-" + Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(stage);
                using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("TugbayReader.zip"))
                using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
                    zip.ExtractToDirectory(stage);

                var check = new ProcessStartInfo(Path.Combine(stage, "runtime", "python.exe"),
                    "-B -c \"import pymupdf; assert pymupdf.VersionBind == '1.28.2'\"");
                check.UseShellExecute = false;
                check.CreateNoWindow = true;
                using (var process = Process.Start(check))
                {
                    process.WaitForExit();
                    if (process.ExitCode != 0) throw new InvalidOperationException("PDF motoru başlatılamadı.");
                }
                Directory.Move(stage, install);
            }

            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
            foreach (string folder in new[] { desktop, menu })
            {
                if (String.IsNullOrEmpty(folder)) continue;
                Directory.CreateDirectory(folder);
                dynamic shortcut = shell.CreateShortcut(Path.Combine(folder, "TugbayReader.lnk"));
                shortcut.TargetPath = runtime;
                shortcut.Arguments = "\"" + app + "\" --desktop";
                shortcut.WorkingDirectory = install;
                shortcut.IconLocation = icon + ",0";
                shortcut.Description = "TugbayReader PDF düzenleyici";
                shortcut.Save();
            }
            if (!testing)
                Process.Start(new ProcessStartInfo(runtime, "\"" + app + "\" --desktop") { WorkingDirectory = install });
            return 0;
        }
        catch (Exception error)
        {
            if (!String.IsNullOrWhiteSpace(testRoot))
                File.WriteAllText(Path.Combine(testRoot, "setup-error.txt"), error.ToString());
            else
                MessageBox.Show(error.Message, "TugbayReader kurulumu", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}



