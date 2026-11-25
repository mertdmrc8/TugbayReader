using System;
using System.IO;
using System.Runtime.InteropServices;

static class WordConverter
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length != 2) return 1;
        Type type = Type.GetTypeFromProgID("Word.Application");
        if (type == null) return 20;
        dynamic word = null;
        dynamic document = null;
        try
        {
            word = Activator.CreateInstance(type);
            word.DisplayAlerts = 0;
            word.AutomationSecurity = 3;
            document = word.Documents.Open(Path.GetFullPath(args[0]), ConfirmConversions: false,
                ReadOnly: true, AddToRecentFiles: false, Visible: false);
            document.ExportAsFixedFormat(Path.GetFullPath(args[1]), 17);
            return File.Exists(args[1]) ? 0 : 1;
        }
        catch (COMException)
        {
            return 1;
        }
        finally
        {
            try { if (document != null) document.Close(0); }
            finally { if (word != null) word.Quit(0); }
        }
    }
}
