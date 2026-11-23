using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed class DesktopWindow : Form
{
    // Keep the origin used by previous versions. Asset requests are intercepted before networking.
    private static readonly Uri Origin = new Uri("http://127.0.0.1:8765/");
    private readonly WebView2 web;
    private readonly Label status;
    private readonly System.Windows.Forms.Timer timer;
    private readonly EventWaitHandle show;
    private readonly EventWaitHandle stop;
    private readonly string data;
    private readonly string program = AppDomain.CurrentDomain.BaseDirectory;
    private DateTime deadline;

    private static readonly Dictionary<string, string> Assets = new Dictionary<string, string> {
        { "/", "text/html" }, { "/index.html", "text/html" }, { "/style.css", "text/css" },
        { "/app.js", "text/javascript" }, { "/storage.js", "text/javascript" },
        { "/covers.js", "text/javascript" }, { "/limiter.js", "text/javascript" },
        { "/playout.js", "text/javascript" }, { "/icon.png", "image/png" }
    };

    public DesktopWindow(string data, EventWaitHandle show, EventWaitHandle stop)
    {
        this.data = data;
        this.show = show;
        this.stop = stop;
        Text = "Station Pilot";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        Size = new Size(1280, 850);
        MinimumSize = new Size(720, 540);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(17, 22, 25);
        web = new WebView2 { Dock = DockStyle.Fill };
        status = new Label {
            Dock = DockStyle.Fill, Text = "Opening the Station Pilot library…",
            TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White,
            Font = new Font("Segoe UI", 11)
        };
        Controls.Add(web);
        Controls.Add(status);
        status.BringToFront();
        timer = new System.Windows.Forms.Timer { Interval = 200 };
        timer.Tick += Tick;
        Shown += Start;
        FormClosed += (sender, args) => { timer.Dispose(); web.Dispose(); };
    }

    private void Tick(object sender, EventArgs args)
    {
        if (stop.WaitOne(0)) { Close(); return; }
        if (show.WaitOne(0))
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }
        if (status.Visible && deadline != DateTime.MaxValue && DateTime.UtcNow > deadline)
            Fail("The console did not finish loading. Close this window and reopen Station Pilot.");
    }

    private async void Start(object sender, EventArgs args)
    {
        deadline = DateTime.MaxValue;
        timer.Start();
        try
        {
#if COMPACT_RUNTIME
            string runtime = null;
            try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException) {
                throw new IOException("Microsoft WebView2 Runtime is unavailable. Use the Station Pilot offline MSI, which includes it.");
            }
#else
            string runtime = Path.Combine(program, "Runtime");
            if (!File.Exists(Path.Combine(runtime, "msedgewebview2.exe")))
                throw new IOException("The embedded runtime is missing. Repair Station Pilot using the MSI.");
#endif
            string profile = Path.Combine(data, "WebView");
            await Task.Run(() => {
                if (runtime != null) AllowRuntimeRead(runtime);
                MigrateLibrary(data, profile);
            });
            if (IsDisposed) return;
            deadline = DateTime.UtcNow.AddSeconds(40);
            var options = new CoreWebView2EnvironmentOptions();
            options.AdditionalBrowserArguments = "--disable-background-networking --disk-cache-size=16777216";
            var environment = await CoreWebView2Environment.CreateAsync(runtime, profile, options);
            if (IsDisposed) return;
            await web.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            var core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.NavigationStarting += (view, request) => {
                Uri uri;
                request.Cancel = !Uri.TryCreate(request.Uri, UriKind.Absolute, out uri) || !IsOrigin(uri);
            };
            core.NewWindowRequested += (view, request) => request.Handled = true;
            core.AddWebResourceRequestedFilter("http://*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
            core.AddWebResourceRequestedFilter("https://*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
            core.WebResourceRequested += SendAsset;
            core.WebMessageReceived += (view, message) => {
                if (message.Source == Origin.AbsoluteUri && message.TryGetWebMessageAsString() == "pilot-ready")
                    status.Visible = false;
            };
            core.ProcessFailed += (view, failure) => Fail("The embedded console stopped. Reopen Station Pilot. (" + failure.ProcessFailedKind + ")");
            core.Navigate(Origin.AbsoluteUri);
        }
        catch (Exception error)
        {
            if (!IsDisposed) Fail("Station Pilot could not open its embedded console.\n\n" + error.Message);
        }
    }

    private void Fail(string message)
    {
        deadline = DateTime.MaxValue;
        status.Text = message;
        status.Visible = true;
        status.BringToFront();
    }

    private static bool IsOrigin(Uri uri)
    {
        return uri.Scheme == Origin.Scheme && uri.Host == Origin.Host && uri.Port == Origin.Port;
    }

    private void SendAsset(object sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        Uri uri;
        string type;
        var environment = web.CoreWebView2.Environment;
        if (!Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out uri) || !IsOrigin(uri)
            || !Assets.TryGetValue(uri.AbsolutePath, out type) || args.Request.Method != "GET")
        {
            args.Response = environment.CreateWebResourceResponse(null, 404, "Not Found", "");
            return;
        }

        string file = uri.AbsolutePath == "/" ? "index.html" : uri.AbsolutePath.Substring(1);
        try
        {
            var bytes = File.ReadAllBytes(Path.Combine(program, file));
            args.Response = environment.CreateWebResourceResponse(new MemoryStream(bytes, false), 200, "OK",
                "Content-Type: " + type + "\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff");
        }
        catch (IOException)
        {
            args.Response = environment.CreateWebResourceResponse(null, 500, "App file unavailable", "");
        }
    }

    private static void AllowRuntimeRead(string runtime)
    {
        var acl = Directory.GetAccessControl(runtime);
        bool changed = false;
        foreach (string sid in new[] { "S-1-15-2-1", "S-1-15-2-2" })
        {
            var identity = new SecurityIdentifier(sid);
            bool found = false;
            foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                if (identity.Equals(rule.IdentityReference) && rule.AccessControlType == AccessControlType.Allow
                    && (rule.FileSystemRights & FileSystemRights.ReadAndExecute) == FileSystemRights.ReadAndExecute
                    && rule.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit))
                    found = true;
            if (found) continue;
            acl.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.ReadAndExecute,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            changed = true;
        }
        if (changed) Directory.SetAccessControl(runtime, acl);
    }

    private static void MigrateLibrary(string data, string profile)
    {
        string old = Path.Combine(data, @"Browser\Default\IndexedDB");
        string target = Path.Combine(profile, @"EBWebView\Default\IndexedDB");
        if (Directory.Exists(target) || !Directory.Exists(old)) return;
        string database = "http_127.0.0.1_8765.indexeddb.leveldb";
        if (!Directory.Exists(Path.Combine(old, database))) return;
        string stage = Path.Combine(profile, "Migration-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            string oldLock = Path.Combine(old, database, "LOCK");
            using (var unlocked = File.Exists(oldLock) ? new FileStream(oldLock, FileMode.Open, FileAccess.Read, FileShare.None) : null)
            {
                CopyTree(Path.Combine(old, database), Path.Combine(stage, database));
                const string blobs = "http_127.0.0.1_8765.indexeddb.blob";
                if (Directory.Exists(Path.Combine(old, blobs))) CopyTree(Path.Combine(old, blobs), Path.Combine(stage, blobs));
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            Directory.Move(stage, target);
        }
        catch (IOException error)
        {
            throw new IOException("Could not copy the previous library. Close the earlier Station Pilot window and reopen the app. " + error.Message, error);
        }
        finally { if (Directory.Exists(stage)) Directory.Delete(stage, true); }
    }

    private static void CopyTree(string source, string destination)
    {
        if ((File.GetAttributes(source) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The legacy library contains a redirected folder.");
        Directory.CreateDirectory(destination);
        foreach (string file in Directory.GetFiles(source))
        {
            if (Path.GetFileName(file) == "LOCK") continue;
            if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("The legacy library contains a redirected file.");
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
        }
        foreach (string folder in Directory.GetDirectories(source)) CopyTree(folder, Path.Combine(destination, Path.GetFileName(folder)));
    }
}
