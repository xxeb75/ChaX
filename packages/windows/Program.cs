using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Chax;

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if (args.Contains("--probe"))
        {
            var text = BleEngine.ProbeAsync().GetAwaiter().GetResult();
            File.WriteAllText(Path.Combine(Path.GetTempPath(), "chax-probe.txt"), text);
            return;
        }
        // --debug: lets a tool drive the page over the DevTools protocol (http://localhost:9222)
        if (args.Contains("--debug")) Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9222");
        Application.Run(new MainForm());
    }
}

/// <summary>The web app in a WebView2 window, with the Bluetooth engine behind a small message bridge.</summary>
sealed class MainForm : Form
{
    readonly WebView2 _web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(10, 10, 12) };
    readonly BleEngine _ble = new();
    static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public MainForm()
    {
        Text = "ChaX";
        BackColor = Color.FromArgb(10, 10, 12);
        ClientSize = new Size(1100, 760);
        MinimumSize = new Size(380, 520);
        Controls.Add(_web);
        Load += async (_, _) => await InitAsync();
        FormClosing += (_, _) => _ble.Stop();
    }

    async Task InitAsync()
    {
        var data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChaX", "webview");
        var env = await CoreWebView2Environment.CreateAsync(null, data);
        await _web.EnsureCoreWebView2Async(env);
        var core = _web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.SetVirtualHostNameToFolderMapping("chax.local", Path.Combine(AppContext.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Allow);
        // the page tells hosts apart by this flag
        await core.AddScriptToExecuteOnDocumentCreatedAsync("window.__chaxHost = 'windows';");
        core.WebMessageReceived += (_, e) => OnPage(e.WebMessageAsJson);
        // links in messages must never navigate the app itself
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith("https://chax.local/")) e.Cancel = true; };

        _ble.LinkUp += l => ToPage(new { t = "up", link = l });
        _ble.LinkDown += l => ToPage(new { t = "down", link = l });
        _ble.Frame += (l, b) => ToPage(new { t = "frame", link = l, data = Convert.ToBase64String(b) });
        _ble.State += m => ToPage(new { t = "state", message = m });

        core.Navigate("https://chax.local/index.html");
    }

    void ToPage(object msg)
    {
        if (IsDisposed) return;
        var json = JsonSerializer.Serialize(msg, Json);
        BeginInvoke(() => _web.CoreWebView2?.PostWebMessageAsJson(json));
    }

    async void OnPage(string raw)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            switch (root.GetProperty("t").GetString())
            {
                case "start":
                {
                    var err = await _ble.StartAsync(Convert.FromHexString(root.GetProperty("id").GetString()!));
                    if (err != null) ToPage(new { t = "error", message = err });
                    break;
                }
                case "stop":
                    _ble.Stop();
                    break;
                case "send":
                    if (!_ble.Send(root.GetProperty("link").GetString()!, Convert.FromBase64String(root.GetProperty("data").GetString()!)))
                        ToPage(new { t = "error", message = "liaison inconnue ou file pleine" });
                    break;
            }
        }
        catch (Exception e)
        {
            ToPage(new { t = "error", message = e.Message });
        }
    }
}
