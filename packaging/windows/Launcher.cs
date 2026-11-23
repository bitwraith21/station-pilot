using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
#if COMPACT_RUNTIME
    private const string ProductCode = "{36AB963F-36A5-44F5-AED9-D101A7DFCCF6}";
#else
    private const string ProductCode = "{B8C4A8E1-55FE-4E92-8D94-1DEF06D9B608}";
#endif
    internal static readonly string root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StationPilot");
    internal static readonly string data = Path.Combine(root, "Data");

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string user = WindowsIdentity.GetCurrent().User.Value;
            bool purge = args.Length == 1 && args[0] == "--purge";
            bool uninstall = args.Length == 1 && args[0] == "--uninstall";
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, @"Local\StationPilot-Show-" + user))
            using (var mutex = new Mutex(false, @"Local\StationPilot-" + user))
            {
                bool acquired;
                try { acquired = mutex.WaitOne(purge || uninstall ? 2500 : 0); }
                catch (AbandonedMutexException) { acquired = true; }
                if (!acquired)
                {
                    if (purge) return 1;
                    show.Set();
                    if (uninstall)
                        throw new InvalidOperationException("Close the Station Pilot playout window before uninstalling. If the window is closed, end StationPilot.exe in Task Manager and try again.");
                    return 0;
                }

                try
                {
                    if (purge) Purge();
                    else if (uninstall) Uninstall();
                    else Run(show, user);
                }
                finally { mutex.ReleaseMutex(); }
                return 0;
            }
        }
        catch (Exception error)
        {
            if (args.Length == 1 && args[0] == "--purge")
                return 1;
            MessageBox.Show(error.Message, "Station Pilot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static void Uninstall()
    {
        var answer = MessageBox.Show(
            "Remove your Station Pilot audio library, queue, schedules, settings, and history?\n\n" +
            "Yes removes the app and its saved data.\nNo removes the app and keeps the data for reinstall.\nCancel leaves everything in place.",
            "Uninstall Station Pilot", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (answer == DialogResult.Cancel) return;
        string arguments = "/x " + ProductCode + (answer == DialogResult.Yes ? " PURGEDATA=1" : "");
        Process.Start(Path.Combine(Environment.SystemDirectory, "msiexec.exe"), arguments);
    }

    private static void Purge()
    {
        CheckDirectory(root);
        if (!Directory.Exists(data)) return;
        CheckDirectory(data);
        // Delete reparse points as links. Never traverse them during the data purge.
        DeleteTree(new DirectoryInfo(data));
    }

    private static void DeleteTree(DirectoryInfo directory)
    {
        foreach (var file in directory.GetFiles())
        {
            if ((file.Attributes & FileAttributes.ReparsePoint) == 0 && file.IsReadOnly)
                file.IsReadOnly = false;
            file.Delete();
        }
        foreach (var child in directory.GetDirectories())
        {
            if ((child.Attributes & FileAttributes.ReparsePoint) != 0) child.Delete();
            else DeleteTree(child);
        }
        directory.Delete();
    }

    private static void CheckDirectory(string directory)
    {
        if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Station Pilot cannot use a redirected application data directory.");
    }

    private static void Run(EventWaitHandle show, string user)
    {
        CheckDirectory(root);
        CheckDirectory(data);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var stop = new EventWaitHandle(false, EventResetMode.ManualReset, @"Local\StationPilot-Stop-" + user))
        using (var window = new DesktopWindow(data, show, stop))
            Application.Run(window);
    }
}
