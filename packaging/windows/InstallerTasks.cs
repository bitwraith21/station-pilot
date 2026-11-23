using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

internal static class InstallerTasks
{
    [STAThread]
    private static int Main(string[] args)
    {
        int ui;
        bool interactive = args.Length > 0 && Int32.TryParse(args[0], out ui) && ui >= 4;
        string user = WindowsIdentity.GetCurrent().User.Value;
        try
        {
            Mutex session = null;
            try { session = Mutex.OpenExisting(@"Local\StationPilot-" + user); }
            catch (WaitHandleCannotBeOpenedException) { }

            EventWaitHandle stop = null;
            try { stop = EventWaitHandle.OpenExisting(@"Local\StationPilot-Stop-" + user); }
            catch (WaitHandleCannotBeOpenedException) { }

            using (session)
            using (stop)
            {
                bool active = session != null && !WaitUntilClosed(session, 0);
                // Older releases can leave a browser window behind after the launcher exits.
                var legacy = stop == null ? FindLegacyBrowsers() : new List<Process>();
                try
                {
                    if (!active && legacy.Count == 0) return 0;
                    if (interactive && MessageBox.Show(
                        "Station Pilot is running. Setup will close it and stop any active playout. Continue?",
                        "Station Pilot Setup", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning,
                        MessageBoxDefaultButton.Button2) != DialogResult.OK) return 1;

                    if (stop != null) stop.Set();
                    foreach (var browser in legacy)
                        if (!browser.HasExited) browser.CloseMainWindow();

                    var elapsed = Stopwatch.StartNew();
                    bool sessionClosed = !active || WaitUntilClosed(session, 12000);
                    if (sessionClosed)
                    {
                        foreach (var browser in legacy)
                            if (!browser.WaitForExit(Math.Max(0, 12000 - (int)elapsed.ElapsedMilliseconds)))
                                sessionClosed = false;
                    }
                    if (sessionClosed) return 0;
                }
                finally { foreach (var browser in legacy) browser.Dispose(); }
            }
        }
        catch (Exception error)
        {
            if (interactive) MessageBox.Show(error.Message, "Station Pilot Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        if (interactive) MessageBox.Show("Station Pilot is still running. Close its playout window and run setup again.",
            "Station Pilot Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 1;
    }

    private static bool WaitUntilClosed(Mutex mutex, int timeout)
    {
        bool acquired;
        try { acquired = mutex.WaitOne(timeout); }
        catch (AbandonedMutexException) { acquired = true; }
        if (acquired) mutex.ReleaseMutex();
        return acquired;
    }

    private static List<Process> FindLegacyBrowsers()
    {
        var browsers = new List<Process>();
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            @"StationPilot\Data\Browser");
        try
        {
            using (var search = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe'"))
            using (var matches = search.Get())
            {
                foreach (ManagementObject row in matches)
                {
                    using (row)
                    {
                        string command = row["CommandLine"] as string;
                        if (String.IsNullOrEmpty(command) ||
                            command.IndexOf("--type=", StringComparison.OrdinalIgnoreCase) >= 0 ||
                            command.IndexOf("--user-data-dir=\"" + profile + "\"", StringComparison.OrdinalIgnoreCase) < 0)
                            continue;
                        try
                        {
                            browsers.Add(Process.GetProcessById(Convert.ToInt32(row["ProcessId"])));
                        }
                        catch (ArgumentException) { }
                    }
                }
            }
        }
        catch (ManagementException) { }
        catch (UnauthorizedAccessException) { }
        return browsers;
    }
}
