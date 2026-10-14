// VibeCMD window helper. Lets you drag an already-open CMD window into VibeCMD.
// The real console (and whatever runs in it, e.g. a Claude chat) keeps running
// untouched; its window is just hidden, so it leaves the taskbar, and a pane
// shows its screen instead.
//
// Any other app window (Notepad, Notepad++, Kate...) can be docked too. Those
// aren't mirrored: the real window is made a child of VibeCMD's and placed
// over its pane, so it works exactly as usual, menus and dialogs included.
//
// Two modes, both talking over stdin/stdout one line per message:
//
// winhelper <VibeCMD hwnd>: watches for windows being dragged.
//   out: drag-move <hwnd> <x> <y> <over>   while a window is being dragged
//        drag-end <hwnd> <x> <y> <over>    (screen pixels; over=1 if VibeCMD is under the cursor)
//        embedded <hwnd> <base64 json>     {title, app, exe, args}; app windows have exe/args
//        error <hwnd> <why> | released <hwnd> | released-all
//        closed <hwnd> | closed-all
//        gone <hwnd>                       a docked window closed by itself
//        title <hwnd> <title>              a docked window's title changed
//        focus <hwnd>                      a docked app window got the keyboard
//        launch <id> <hwnd>                a started app's window (0 if none showed up)
//        close-app <hwnd> <1|0>            the app closed (1) or stayed open (0, e.g. Cancel)
//        reveal <hwnd> | closed-apps | apps-kept   while closing every app on quit
//   in:  embed <hwnd> | release <hwnd> | close <hwnd> | release-all | close-all
//        place <hwnd> <x> <y> <w> <h>      show an app window there (VibeCMD client pixels)
//        hide <hwnd> | focus <hwnd> | close-app <hwnd> | close-apps
//        launch <id> <base64 json>         {exe, args}: start an app, report its window
//   If VibeCMD goes away (stdin closes) every window is given back first.
//
// winhelper mirror <hwnd>: one per docked window. Attaches to its console and
// writes the visible screen to stdout as terminal text (only the rows that
// changed), and types what it's sent into the console.
//   in:  r <cols> <rows>                   pane size; nothing is drawn before the first one
//        w <base64 utf-8>                  keys from xterm.js
//        s <lines>                         scroll the view (+ = down)
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class WinHelper
{
    const string ConsoleClass = "ConsoleWindowClass";

    class Embedded
    {
        public IntPtr Hwnd;
        public RECT Rect;
        public string Title;
        // An app window (not a console), with what it looked like before docking.
        public bool App;
        public long Style, ExStyle;
    }

    static IntPtr host;
    static readonly Dictionary<long, Embedded> embedded = new Dictionary<long, Embedded>();
    static readonly object gate = new object();
    static IntPtr dragging = IntPtr.Zero;
    static Timer dragTimer, watchTimer;
    static WinEventDelegate hookProc;

    static int Main(string[] args)
    {
        // Real pixels everywhere, so cursor and window positions match what
        // Electron expects on scaled or mixed-DPI monitors.
        try { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); } catch (EntryPointNotFoundException) { }
        if (args[0] == "mirror") return Mirror.Run(new IntPtr(long.Parse(args[1])));
        host = new IntPtr(long.Parse(args[0]));
        // Set up before closing windows attaches to their consoles (see
        // CloseWindows), which can repoint the std handles.
        GC.KeepAlive(Console.In);
        GC.KeepAlive(Console.Out);
        SetConsoleCtrlHandler(IntPtr.Zero, true);
        hookProc = OnWinEvent;
        SetWinEventHook(EVENT_SYSTEM_MOVESIZESTART, EVENT_SYSTEM_MOVESIZEEND, IntPtr.Zero, hookProc, 0, 0, WINEVENT_OUTOFCONTEXT);
        focusProc = OnFocus;
        SetWinEventHook(EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS, IntPtr.Zero, focusProc, 0, 0, WINEVENT_OUTOFCONTEXT);
        watchTimer = new Timer(_ => WatchEmbedded(), null, 700, 700);

        var reader = new Thread(() =>
        {
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                try { Handle(line.Trim()); }
                catch (Exception e) { Emit("log " + e.Message.Replace('\n', ' ')); }
            }
            ReleaseAll();
            Environment.Exit(0);
        });
        reader.IsBackground = true;
        reader.Start();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        return 0;
    }

    static void Emit(string line)
    {
        lock (gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }

    // ------------------------------------------------------------ dragging

    static void OnWinEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (idObject != 0 || (ClassOf(hwnd) != ConsoleClass && !Dockable(hwnd))) return;
        if (ev == EVENT_SYSTEM_MOVESIZESTART)
        {
            dragging = hwnd;
            dragTimer = new Timer(_ => ReportDrag("drag-move"), null, 0, 40);
        }
        else if (ev == EVENT_SYSTEM_MOVESIZEEND && hwnd == dragging)
        {
            if (dragTimer != null) dragTimer.Dispose();
            dragTimer = null;
            ReportDrag("drag-end");
            dragging = IntPtr.Zero;
            SeeThrough(hwnd, false);
        }
    }

    static void ReportDrag(string kind)
    {
        IntPtr h = dragging;
        if (h == IntPtr.Zero) return;
        POINT p;
        GetCursorPos(out p);
        bool over = HostIsUnder(p, h);
        if (kind == "drag-move") SeeThrough(h, over);
        Emit(kind + " " + h.ToInt64() + " " + p.X + " " + p.Y + " " + (over ? 1 : 0));
    }

    // While it's over VibeCMD the dragged window is made mostly transparent, so
    // the drop preview underneath it can be seen. Its own opacity setting (cmd's
    // Properties > Colors > Opacity) is put back afterwards.
    static bool seeThrough;
    static long savedExStyle;
    static uint savedKey, savedFlags;
    static byte savedAlpha;

    static void SeeThrough(IntPtr h, bool on)
    {
        lock (gate)
        {
            if (on && h != dragging) return; // a timer tick that lost the race with the drop
            if (on == seeThrough) return;
            seeThrough = on;
            if (on)
            {
                savedExStyle = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
                if ((savedExStyle & WS_EX_LAYERED) != 0) GetLayeredWindowAttributes(h, out savedKey, out savedAlpha, out savedFlags);
                SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(savedExStyle | WS_EX_LAYERED));
                SetLayeredWindowAttributes(h, 0, 70, LWA_ALPHA);
            }
            else
            {
                if ((savedExStyle & WS_EX_LAYERED) != 0) SetLayeredWindowAttributes(h, savedKey, savedAlpha, savedFlags);
                SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(savedExStyle));
            }
        }
    }

    // True if, ignoring the window being dragged, VibeCMD is the topmost
    // window under the cursor (so dropping onto a window covering it doesn't count).
    static bool HostIsUnder(POINT p, IntPtr ignore)
    {
        for (IntPtr w = GetTopWindow(IntPtr.Zero); w != IntPtr.Zero; w = GetWindow(w, GW_HWNDNEXT))
        {
            if (w == ignore || !IsWindowVisible(w) || IsIconic(w)) continue;
            long ex = GetWindowLongPtr(w, GWL_EXSTYLE).ToInt64();
            if ((ex & WS_EX_TRANSPARENT) != 0) continue;
            if ((ex & WS_EX_LAYERED) != 0 && (ex & WS_EX_TOOLWINDOW) != 0) continue;
            int cloaked;
            if (DwmGetWindowAttribute(w, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) continue;
            RECT r;
            GetWindowRect(w, out r);
            if (p.X >= r.Left && p.X < r.Right && p.Y >= r.Top && p.Y < r.Bottom) return w == host;
        }
        return false;
    }

    // ------------------------------------------------------------ docking

    static void Handle(string line)
    {
        if (line.Length == 0) return;
        string[] a = line.Split(' ');
        if (a[0] == "release-all") { ReleaseAll(); Emit("released-all"); return; }
        if (a[0] == "close-all") { CloseAll(); Emit("closed-all"); return; }
        if (a[0] == "close-apps") { Background(CloseApps); return; }
        if (a[0] == "launch") { string id0 = a[1], spec = a[2]; Background(() => Launch(id0, spec)); return; }
        long id = long.Parse(a[1]);
        IntPtr h = new IntPtr(id);
        Embedded e;
        lock (gate) embedded.TryGetValue(id, out e);

        switch (a[0])
        {
            case "embed":
                bool console = IsWindow(h) && ClassOf(h) == ConsoleClass;
                if (!console && !Dockable(h)) { Emit("error " + id + " can't dock that window"); return; }
                if (e == null && !(console ? Embed(h) : EmbedApp(h))) { Emit("error " + id + " can't dock that window"); return; }
                lock (gate) embedded.TryGetValue(id, out e);
                Emit("embedded " + id + " " + Describe(e));
                break;
            case "release":
                if (e != null) { Release(e); Emit("released " + id); }
                break;
            case "close":
                lock (gate) embedded.Remove(id);
                CloseWindows(new List<IntPtr> { h });
                Emit("closed " + id);
                break;
            case "place":
                if (e == null || !e.App) return;
                // Async, so an app that's hung can't hold up every other pane.
                SetWindowPos(h, HWND_TOP, int.Parse(a[2]), int.Parse(a[3]), int.Parse(a[4]), int.Parse(a[5]),
                    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_ASYNCWINDOWPOS);
                break;
            case "hide":
                if (e != null && e.App) ShowWindowAsync(h, SW_HIDE);
                break;
            case "focus":
                if (e != null && e.App) FocusApp(h);
                break;
            case "close-app":
                if (e == null || !e.App) { Emit("close-app " + id + " 1"); return; }
                Background(() => Emit("close-app " + id + (CloseApp(e) ? " 1" : " 0")));
                break;
        }
    }

    static void Background(ThreadStart work)
    {
        var t = new Thread(() => { try { work(); } catch (Exception ex) { Emit("log " + ex.Message.Replace('\n', ' ')); } });
        t.IsBackground = true;
        t.Start();
    }

    static bool Embed(IntPtr h)
    {
        var e = new Embedded { Hwnd = h, Title = TitleOf(h) };
        GetWindowRect(h, out e.Rect);
        ShowWindow(h, SW_HIDE);
        lock (gate) embedded[h.ToInt64()] = e;
        return true;
    }

    // Ordinary top-level app windows: not consoles, not VibeCMD's own, not the
    // desktop or taskbar, not dialogs or tool windows that belong to another.
    static readonly HashSet<string> NotDockable = new HashSet<string>
    {
        "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Progman", "WorkerW",
        // Store apps live inside a frame owned by another process; moving
        // that frame into VibeCMD leaves the app itself behind.
        "ApplicationFrameWindow", "Windows.UI.Core.CoreWindow",
    };

    static bool Dockable(IntPtr h)
    {
        if (!IsWindow(h) || h == host || GetParent(h) != IntPtr.Zero || GetWindow(h, GW_OWNER) != IntPtr.Zero) return false;
        long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64(), ex = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
        if ((style & WS_CAPTION) != WS_CAPTION || (ex & WS_EX_TOOLWINDOW) != 0) return false;
        string cls = ClassOf(h);
        if (cls == ConsoleClass || NotDockable.Contains(cls)) return false;
        uint pid, hostPid;
        GetWindowThreadProcessId(h, out pid);
        GetWindowThreadProcessId(host, out hostPid);
        return pid != hostPid && pid != (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    }

    // The window becomes a child of VibeCMD's, without its frame. It stays
    // hidden until VibeCMD places it over its pane.
    static bool EmbedApp(IntPtr h)
    {
        if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, SW_RESTORE);
        var e = new Embedded { Hwnd = h, Title = TitleOf(h), App = true };
        GetWindowRect(h, out e.Rect);
        e.Style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
        e.ExStyle = GetWindowLongPtr(h, GWL_EXSTYLE).ToInt64();
        ShowWindow(h, SW_HIDE);
        SetWindowLongPtr(h, GWL_STYLE, new IntPtr((e.Style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU)) | WS_CHILD));
        SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(e.ExStyle & ~(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_DLGMODALFRAME)));
        if (SetParent(h, host) == IntPtr.Zero)
        {
            // An app running as administrator can't be adopted by one that isn't.
            SetWindowLongPtr(h, GWL_STYLE, new IntPtr(e.Style));
            SetWindowLongPtr(h, GWL_EXSTYLE, new IntPtr(e.ExStyle));
            ShowWindow(h, SW_SHOW);
            return false;
        }
        SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        lock (gate) embedded[h.ToInt64()] = e;
        return true;
    }

    // What VibeCMD needs to reopen an app next time: its program and the
    // arguments it was started with (usually the file it opened).
    static string Describe(Embedded e)
    {
        var sb = new StringBuilder("{\"title\":").Append(Json(TitleOf(e.Hwnd))).Append(",\"app\":").Append(e.App ? "true" : "false");
        if (e.App)
        {
            uint pid;
            GetWindowThreadProcessId(e.Hwnd, out pid);
            string exe = ExeOf(pid);
            sb.Append(",\"exe\":").Append(Json(exe)).Append(",\"args\":").Append(Json(ArgsOf(pid)));
        }
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(sb.Append('}').ToString()));
    }

    static string Json(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string ExeOf(uint pid)
    {
        IntPtr p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (p == IntPtr.Zero) return "";
        try
        {
            var sb = new StringBuilder(1024);
            int n = sb.Capacity;
            return QueryFullProcessImageName(p, 0, sb, ref n) ? sb.ToString() : "";
        }
        finally { CloseHandle(p); }
    }

    // The command line minus the program itself.
    static string ArgsOf(uint pid)
    {
        try
        {
            using (var q = new System.Management.ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + pid))
            foreach (System.Management.ManagementObject o in q.Get())
            {
                string cmd = ((o["CommandLine"] as string) ?? "").TrimStart();
                int end = cmd.StartsWith("\"") ? cmd.IndexOf('"', 1) + 1 : cmd.IndexOf(' ');
                return end <= 0 || end >= cmd.Length ? "" : cmd.Substring(end).Trim();
            }
        }
        catch (Exception) { /* no WMI: reopen it without arguments */ }
        return "";
    }

    static void Release(Embedded e, bool show = true)
    {
        lock (gate) embedded.Remove(e.Hwnd.ToInt64());
        if (!IsWindow(e.Hwnd)) return;
        if (e.App)
        {
            ShowWindow(e.Hwnd, SW_HIDE);
            SetParent(e.Hwnd, IntPtr.Zero);
            SetWindowLongPtr(e.Hwnd, GWL_STYLE, new IntPtr(e.Style & ~WS_VISIBLE));
            SetWindowLongPtr(e.Hwnd, GWL_EXSTYLE, new IntPtr(e.ExStyle));
            SetWindowPos(e.Hwnd, HWND_TOP, e.Rect.Left, e.Rect.Top, e.Rect.Right - e.Rect.Left, e.Rect.Bottom - e.Rect.Top,
                SWP_FRAMECHANGED | SWP_NOACTIVATE);
            if (!show) return;
        }
        ShowWindow(e.Hwnd, IsIconic(e.Hwnd) ? SW_RESTORE : SW_SHOW);
        SetWindowPos(e.Hwnd, HWND_TOP, e.Rect.Left, e.Rect.Top, 0, 0, SWP_NOSIZE | SWP_SHOWWINDOW);
        SetForegroundWindow(e.Hwnd);
    }

    static void ReleaseAll()
    {
        List<Embedded> all;
        lock (gate) all = new List<Embedded>(embedded.Values);
        foreach (var e in all) Release(e);
    }

    // Quitting VibeCMD closes docked windows, like closing their panes does.
    // App windows have been asked to close already (close-apps); any still
    // here are given back rather than destroyed along with VibeCMD's window.
    static void CloseAll()
    {
        var all = new List<IntPtr>();
        var apps = new List<Embedded>();
        lock (gate)
        {
            foreach (var e in embedded.Values) { if (e.App) apps.Add(e); else all.Add(e.Hwnd); }
            embedded.Clear();
        }
        foreach (var e in apps) Release(e);
        CloseWindows(all);
    }

    // ------------------------------------------------------------ app windows

    static IntPtr lastFocus;
    static WinEventDelegate focusProc;

    // Clicking into a docked app gives it the keyboard without VibeCMD hearing
    // about it, so tell VibeCMD which pane that was.
    static void OnFocus(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
    {
        if (hwnd == IntPtr.Zero || GetAncestor(hwnd, GA_ROOT) != host) return;
        for (IntPtr w = hwnd; w != IntPtr.Zero && w != host; w = GetParent(w))
        {
            Embedded e;
            lock (gate) embedded.TryGetValue(w.ToInt64(), out e);
            if (e == null || !e.App) continue;
            if (w != lastFocus) { lastFocus = w; Emit("focus " + w.ToInt64()); }
            return;
        }
        lastFocus = IntPtr.Zero;
    }

    // Docked windows share VibeCMD's input queue, so joining it lets us move
    // the keyboard into the app.
    static void FocusApp(IntPtr h)
    {
        uint ignored;
        uint me = GetCurrentThreadId(), hostThread = GetWindowThreadProcessId(host, out ignored);
        AttachThreadInput(me, hostThread, true);
        SetFocus(h);
        AttachThreadInput(me, hostThread, false);
    }

    // Asks the app to close the way its own ✕ would, so it can offer to save.
    // True once it's gone; false if it's still open (the user picked Cancel).
    static bool CloseApp(Embedded e)
    {
        IntPtr h = e.Hwnd;
        if (!IsWindow(h)) return true;
        PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        bool asked = false;
        long quietSince = 0;
        while (true)
        {
            Thread.Sleep(100);
            if (!IsWindow(h)) { lock (gate) embedded.Remove(h.ToInt64()); return true; }
            // Some apps only hide when closed (to the tray, say); give those
            // back so they aren't destroyed along with VibeCMD.
            if (!IsWindowVisible(h)) { Release(e, false); return true; }
            // A save question (or the Save As after it) is modal: it disables
            // the window it belongs to, which for a docked app is VibeCMD's.
            if (!IsWindowEnabled(host) || !IsWindowEnabled(h)) { asked = true; quietSince = clock.ElapsedMilliseconds; continue; }
            if (clock.ElapsedMilliseconds - quietSince > (asked ? 800 : 3000)) return false;
        }
    }

    // On quit: each app in turn is shown and asked to close. Stops at the first
    // one that stays open, so VibeCMD stays open too.
    static void CloseApps()
    {
        List<Embedded> apps = new List<Embedded>();
        lock (gate) foreach (var e in embedded.Values) if (e.App) apps.Add(e);
        foreach (var e in apps)
        {
            if (!IsWindow(e.Hwnd)) continue;
            Emit("reveal " + e.Hwnd.ToInt64());
            Thread.Sleep(150);
            if (!CloseApp(e)) { Emit("apps-kept"); return; }
        }
        Emit("closed-apps");
    }

    // Starts a program and reports the first normal window it shows. Apps that
    // allow only one copy (Notepad++) hand the file to the copy already running
    // and exit; then that copy's window is used, if it isn't docked already.
    static void Launch(string id, string spec)
    {
        string json = Encoding.UTF8.GetString(Convert.FromBase64String(spec));
        string exe = JsonField(json, "exe"), args = JsonField(json, "args");
        var before = new HashSet<long>();
        EnumWindows((w, _) => { before.Add(w.ToInt64()); return true; }, IntPtr.Zero);
        uint pid = 0;
        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo(exe, args) { UseShellExecute = false };
            try { psi.WorkingDirectory = Path.GetDirectoryName(exe); } catch (Exception) { }
            pid = (uint)System.Diagnostics.Process.Start(psi).Id;
        }
        catch (Exception)
        {
            // Store apps' own folders are off limits; start them by name instead.
            try { pid = (uint)System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.GetFileName(exe), args) { UseShellExecute = true }).Id; }
            catch (Exception) { Emit("launch " + id + " 0"); return; }
        }
        IntPtr found = IntPtr.Zero;
        for (int i = 0; i < 150 && found == IntPtr.Zero; i++)
        {
            Thread.Sleep(100);
            EnumWindows((w, _) =>
            {
                if (before.Contains(w.ToInt64()) || !IsWindowVisible(w) || !Dockable(w)) return true;
                uint p;
                GetWindowThreadProcessId(w, out p);
                if (p != pid && !SameExe(p, exe)) return true;
                found = w;
                return false;
            }, IntPtr.Zero);
            // Handed off to a copy that's already open: no new window will come.
            if (i == 30 && found == IntPtr.Zero) found = ExistingWindowOf(exe);
        }
        Emit("launch " + id + " " + found.ToInt64());
    }

    static bool SameExe(uint pid, string exe)
    {
        return string.Equals(Path.GetFileName(ExeOf(pid)), Path.GetFileName(exe), StringComparison.OrdinalIgnoreCase);
    }

    static IntPtr ExistingWindowOf(string exe)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((w, _) =>
        {
            if (!IsWindowVisible(w) || !Dockable(w)) return true;
            uint p;
            GetWindowThreadProcessId(w, out p);
            if (!SameExe(p, exe)) return true;
            found = w;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // Enough JSON for the two strings VibeCMD sends.
    static string JsonField(string json, string name)
    {
        int at = json.IndexOf("\"" + name + "\":\"");
        if (at < 0) return "";
        var sb = new StringBuilder();
        for (int i = at + name.Length + 4; i < json.Length && json[i] != '"'; i++)
        {
            if (json[i] != '\\') { sb.Append(json[i]); continue; }
            char c = json[++i];
            if (c == 'u') { sb.Append((char)Convert.ToInt32(json.Substring(i + 1, 4), 16)); i += 4; }
            else sb.Append(c == 'n' ? '\n' : c == 't' ? '\t' : c == 'r' ? '\r' : c);
        }
        return sb.ToString();
    }

    // Ends everything running in each window's console, the same way VibeCMD
    // ends its own panes. Just asking the window to close lets programs in it
    // (Claude, for one) run their shutdown work, and anything they start then
    // has no console left and pops up in a new CMD window of its own.
    static void CloseWindows(List<IntPtr> windows)
    {
        uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id, hostPid;
        GetWindowThreadProcessId(host, out hostPid);
        var pids = new List<uint>();
        var list = new uint[64];
        foreach (var h in windows)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            var mine = new List<uint>();
            if (pid != 0) mine.Add(pid);
            FreeConsole();
            if (pid != 0 && AttachConsole(pid))
            {
                uint n = GetConsoleProcessList(list, (uint)list.Length);
                for (int i = 0; i < n && i < list.Length; i++)
                    if (list[i] != self && !mine.Contains(list[i])) mine.Add(list[i]);
                FreeConsole();
            }
            // VibeCMD itself was started from this window: killing its process
            // tree would take VibeCMD down too, so only ask it to close.
            if (mine.Contains(hostPid)) continue;
            pids.AddRange(mine);
        }
        if (pids.Count > 0)
        {
            var args = new StringBuilder("/F /T");
            foreach (var p in pids) args.Append(" /PID ").Append(p);
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo("taskkill.exe", args.ToString())
                {
                    CreateNoWindow = true, UseShellExecute = false,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                };
                System.Diagnostics.Process.Start(psi).WaitForExit(2500);
            }
            catch (Exception) { /* fall back to asking the windows to close */ }
        }
        foreach (var h in windows) if (IsWindow(h)) PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    static void WatchEmbedded()
    {
        List<Embedded> all;
        lock (gate) all = new List<Embedded>(embedded.Values);
        foreach (var e in all)
        {
            if (!IsWindow(e.Hwnd))
            {
                lock (gate) embedded.Remove(e.Hwnd.ToInt64());
                Emit("gone " + e.Hwnd.ToInt64());
                continue;
            }
            // Something in the console asked for its window to be shown again.
            if (!e.App && IsWindowVisible(e.Hwnd)) ShowWindow(e.Hwnd, SW_HIDE);
            string t = TitleOf(e.Hwnd);
            if (t != e.Title) { e.Title = t; Emit("title " + e.Hwnd.ToInt64() + " " + t); }
        }
    }

    static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string TitleOf(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString().Replace('\n', ' ');
    }

    // ------------------------------------------------------------ Win32

    const uint EVENT_SYSTEM_MOVESIZESTART = 0x000A, EVENT_SYSTEM_MOVESIZEEND = 0x000B, EVENT_OBJECT_FOCUS = 0x8005, WINEVENT_OUTOFCONTEXT = 0;
    const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
    const long WS_EX_TRANSPARENT = 0x00000020L, WS_EX_LAYERED = 0x00080000L, WS_EX_TOOLWINDOW = 0x00000080L;
    const long WS_EX_APPWINDOW = 0x00040000L, WS_EX_WINDOWEDGE = 0x00000100L, WS_EX_DLGMODALFRAME = 0x00000001L;
    const long WS_POPUP = 0x80000000L, WS_CHILD = 0x40000000L, WS_VISIBLE = 0x10000000L, WS_CAPTION = 0x00C00000L;
    const long WS_THICKFRAME = 0x00040000L, WS_SYSMENU = 0x00080000L, WS_MINIMIZEBOX = 0x00020000L, WS_MAXIMIZEBOX = 0x00010000L;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;
    const uint SWP_SHOWWINDOW = 0x40, SWP_ASYNCWINDOWPOS = 0x4000;
    const int SW_HIDE = 0, SW_SHOW = 5, SW_RESTORE = 9;
    const uint GW_HWNDNEXT = 2, GW_OWNER = 4, GA_ROOT = 2;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const int DWMWA_CLOAKED = 14;
    const uint LWA_ALPHA = 0x2;
    const uint WM_CLOSE = 0x0010;
    static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    static readonly IntPtr HWND_TOP = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

    delegate void WinEventDelegate(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
    delegate bool EnumWindowsProc(IntPtr h, IntPtr param);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc proc, IntPtr param);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, uint flags, StringBuilder sb, ref int size);

    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventDelegate proc, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32.dll")] static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
    [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] list, uint count);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
}

static class Mirror
{
    static IntPtr window, conout, conin;
    static Stream output;
    static readonly object gate = new object();
    static int cols, rows; // the pane's size; 0 until VibeCMD sends it
    static string[] shown = new string[0];
    static int shownWidth;
    static string shownCursor;

    public static int Run(IntPtr hwnd)
    {
        // Grabbed before switching consoles, which can repoint the std handles.
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        output = Console.OpenStandardOutput();
        window = hwnd;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        FreeConsole();
        if (!AttachConsole(pid)) { Write("\x1b[31mCouldn't connect to that window's console.\x1b[0m"); return 1; }
        SetConsoleCtrlHandler(IntPtr.Zero, true); // Ctrl+C sent to the console isn't for us
        conin = CreateFile("CONIN$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);

        var reader = new Thread(() =>
        {
            string line;
            while ((line = input.ReadLine()) != null)
            {
                try { lock (gate) Handle(line); } catch { /* a bad line shouldn't stop the pane */ }
            }
            try { lock (gate) RestoreFont(); } catch { }
            Environment.Exit(0);
        });
        reader.IsBackground = true;
        reader.Start();

        var procs = new uint[4];
        for (int tick = 0; ; tick++)
        {
            // Once everything else has exited (e.g. `exit` in cmd), let go so
            // the console, and its window, can close.
            if (GetConsoleProcessList(procs, (uint)procs.Length) <= 1) return 0;
            lock (gate) if (cols > 0)
            {
                // Every half second, size it to the pane again: a program
                // switching screen buffers, or a resize the console only
                // half took, leaves it the wrong size until the next one.
                if (tick % 16 == 0) { OpenScreen(); Resize(); }
                Frame();
            }
            Thread.Sleep(30);
        }
    }

    static void Write(string s)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(s);
            output.Write(b, 0, b.Length);
            output.Flush();
        }
        catch (IOException) { Environment.Exit(0); }
    }

    static void Handle(string line)
    {
        string[] a = line.Split(' ');
        if (a[0] == "r") { cols = int.Parse(a[1]); rows = int.Parse(a[2]); OpenScreen(); Resize(); shown = new string[0]; }
        else if (a[0] == "s") { OpenScreen(); Scroll(int.Parse(a[1])); }
        else if (a[0] == "w") Type(Encoding.UTF8.GetString(Convert.FromBase64String(a[1])));
    }

    // Reopened every time, so a program that switches to another screen buffer
    // (full-screen apps do) is followed there.
    static void OpenScreen()
    {
        if (conout != IntPtr.Zero) CloseHandle(conout);
        conout = CreateFile("CONOUT$", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    }

    // ------------------------------------------------------------ screen -> pane

    static void Frame()
    {
        OpenScreen();
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(conout, out info)) return;
        SMALL_RECT view = info.srWindow;
        int w = Math.Min(view.Right - view.Left + 1, cols), h = Math.Min(view.Bottom - view.Top + 1, rows);
        var sb = new StringBuilder();
        if (shown.Length != h || w != shownWidth) { sb.Append("\x1b[0m\x1b[2J"); shown = new string[h]; shownWidth = w; }

        var cells = new CHAR_INFO[w];
        for (int y = 0; y < h; y++)
        {
            var r = new SMALL_RECT { Left = view.Left, Top = (short)(view.Top + y), Right = (short)(view.Left + w - 1), Bottom = (short)(view.Top + y) };
            if (!ReadConsoleOutput(conout, cells, new COORD { X = (short)w, Y = 1 }, new COORD(), ref r)) return;
            string line = Row(cells, w);
            if (line == shown[y]) continue;
            shown[y] = line;
            sb.Append("\x1b[").Append(y + 1).Append(";1H").Append(line);
        }

        CONSOLE_CURSOR_INFO ci;
        GetConsoleCursorInfo(conout, out ci);
        int cx = info.dwCursorPosition.X - view.Left, cy = info.dwCursorPosition.Y - view.Top;
        string cursor = ci.bVisible && cx >= 0 && cx < w && cy >= 0 && cy < h
            ? "\x1b[" + (cy + 1) + ";" + (cx + 1) + "H\x1b[?25h" : "\x1b[?25l";
        if (sb.Length == 0 && cursor == shownCursor) return;
        shownCursor = cursor;
        Write(sb.Append(cursor).ToString());
    }

    static string Row(CHAR_INFO[] cells, int w)
    {
        var sb = new StringBuilder(w + 16);
        int current = -1;
        for (int x = 0; x < w; x++)
        {
            int a = cells[x].Attributes;
            if ((a & COMMON_LVB_TRAILING_BYTE) != 0) continue; // second half of a wide character
            int style = a & (0xFF | COMMON_LVB_REVERSE_VIDEO | COMMON_LVB_UNDERSCORE);
            if (style != current) { sb.Append(Sgr(style)); current = style; }
            char c = cells[x].UnicodeChar;
            sb.Append(c < ' ' ? ' ' : c);
        }
        return sb.Append("\x1b[0m").ToString();
    }

    // Console colours are numbered BGR, ANSI ones RGB. Grey-on-black (the
    // console's normal look) maps to the pane's own default colours, so docked
    // windows follow the VibeCMD theme.
    static readonly int[] Ansi = { 0, 4, 2, 6, 1, 5, 3, 7 };

    static string Sgr(int style)
    {
        int fg = style & 0xF, bg = (style >> 4) & 0xF;
        var sb = new StringBuilder("\x1b[0");
        if (fg != 7) sb.Append(';').Append(((fg & 8) != 0 ? 90 : 30) + Ansi[fg & 7]);
        if (bg != 0) sb.Append(';').Append(((bg & 8) != 0 ? 100 : 40) + Ansi[bg & 7]);
        if ((style & COMMON_LVB_REVERSE_VIDEO) != 0) sb.Append(";7");
        if ((style & COMMON_LVB_UNDERSCORE) != 0) sb.Append(";4");
        return sb.Append('m').ToString();
    }

    // ------------------------------------------------------------ pane size

    static void Resize()
    {
        ShrinkFont();
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(conout, out info)) return;
        COORD largest = GetLargestConsoleWindowSize(conout);
        short w = (short)Math.Max(1, Math.Min(cols, largest.X > 0 ? (int)largest.X : cols));
        short h = (short)Math.Max(1, Math.Min(rows, largest.Y > 0 ? (int)largest.Y : rows));
        short bufH = Math.Max(info.dwSize.Y, h);
        int oldTop = info.srWindow.Top;
        int oldW = info.srWindow.Right - info.srWindow.Left + 1, oldH = info.srWindow.Bottom - info.srWindow.Top + 1;
        if (info.dwSize.X == w && oldW == w && oldH == h) return;

        // The view always has to fit inside the buffer, so a narrower buffer
        // needs a narrower view first. Only the width changes here: cursor moves
        // from a running program are clamped to the view, so a tiny one, even
        // for a moment, piles its output up in one spot.
        if (w < oldW)
        {
            var narrow = new SMALL_RECT { Left = 0, Top = info.srWindow.Top, Right = (short)(w - 1), Bottom = info.srWindow.Bottom };
            SetConsoleWindowInfo(conout, true, ref narrow);
        }
        SetConsoleScreenBufferSize(conout, new COORD { X = w, Y = bufH });

        GetConsoleScreenBufferInfo(conout, out info);
        int top = Math.Max(0, Math.Min(oldTop, info.dwSize.Y - h));
        if (info.dwCursorPosition.Y >= top + h) top = info.dwCursorPosition.Y - h + 1;
        var view = new SMALL_RECT { Left = 0, Top = (short)top, Right = (short)(w - 1), Bottom = (short)(top + h - 1) };
        SetConsoleWindowInfo(conout, true, ref view);

        // A full-screen program's alternate screen (Claude's, for one) ignores
        // all of the above and keeps its old view, but it does follow the size
        // of the console window, so size the hidden window to fit instead. Its
        // scrollbars come and go with the size, so measure again and correct.
        for (int i = 0; i < 3; i++)
        {
            GetConsoleScreenBufferInfo(conout, out info);
            int vw = info.srWindow.Right - info.srWindow.Left + 1, vh = info.srWindow.Bottom - info.srWindow.Top + 1;
            if (vw == w && vh == h) return;
            RECT wr, cr;
            if (!GetWindowRect(window, out wr) || !GetClientRect(window, out cr) || cr.Right < vw || cr.Bottom < vh) return;
            int cw = cr.Right / vw, ch = cr.Bottom / vh;
            SetWindowPos(window, IntPtr.Zero, 0, 0, wr.Right - wr.Left + (w - vw) * cw, wr.Bottom - wr.Top + (h - vh) * ch,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }

    // A console can't be bigger than fits on its monitor at its font size, so
    // a pane larger than that got a smaller screen (short of the right edge or
    // the bottom). The window is hidden anyway, so it gets a tiny font while
    // docked and its own font back afterwards. The font belongs to each screen
    // buffer, so this is checked again for whichever one is showing.
    const short TinyFont = 6;
    static CONSOLE_FONT_INFOEX savedFont;
    static bool fontSaved;

    static void ShrinkFont()
    {
        var f = new CONSOLE_FONT_INFOEX { cbSize = (uint)Marshal.SizeOf(typeof(CONSOLE_FONT_INFOEX)) };
        if (!GetCurrentConsoleFontEx(conout, false, ref f) || f.dwFontSize.Y <= TinyFont) return;
        if (!fontSaved) { savedFont = f; fontSaved = true; }
        // Raster fonts only come in a few sizes, none this small.
        if ((f.FontFamily & TMPF_TRUETYPE) == 0) { f.FaceName = "Consolas"; f.FontFamily = FF_MODERN | TMPF_TRUETYPE | TMPF_VECTOR; }
        f.nFont = 0;
        f.dwFontSize = new COORD { X = 0, Y = TinyFont };
        SetCurrentConsoleFontEx(conout, false, ref f);
    }

    static void RestoreFont()
    {
        if (!fontSaved) return;
        OpenScreen();
        SetCurrentConsoleFontEx(conout, false, ref savedFont);
    }

    static void Scroll(int lines)
    {
        CONSOLE_SCREEN_BUFFER_INFO info;
        if (!GetConsoleScreenBufferInfo(conout, out info)) return;
        int h = info.srWindow.Bottom - info.srWindow.Top + 1;
        int top = Math.Max(0, Math.Min(info.srWindow.Top + lines, info.dwSize.Y - h));
        var view = new SMALL_RECT { Left = info.srWindow.Left, Top = (short)top, Right = info.srWindow.Right, Bottom = (short)(top + h - 1) };
        SetConsoleWindowInfo(conout, true, ref view);
    }

    // ------------------------------------------------------------ pane -> keyboard

    // What xterm.js sends for keys that aren't plain characters.
    static readonly Dictionary<string, ushort> Special = new Dictionary<string, ushort>
    {
        { "\x1b[A", 0x26 }, { "\x1b[B", 0x28 }, { "\x1b[C", 0x27 }, { "\x1b[D", 0x25 },
        { "\x1b[H", 0x24 }, { "\x1b[F", 0x23 }, { "\x1b[2~", 0x2D }, { "\x1b[3~", 0x2E },
        { "\x1b[5~", 0x21 }, { "\x1b[6~", 0x22 },
        { "\x1bOP", 0x70 }, { "\x1bOQ", 0x71 }, { "\x1bOR", 0x72 }, { "\x1bOS", 0x73 },
        { "\x1b[15~", 0x74 }, { "\x1b[17~", 0x75 }, { "\x1b[18~", 0x76 }, { "\x1b[19~", 0x77 },
        { "\x1b[20~", 0x78 }, { "\x1b[21~", 0x79 }, { "\x1b[23~", 0x7A }, { "\x1b[24~", 0x7B },
    };

    static void Type(string s)
    {
        var recs = new List<INPUT_RECORD>();
        for (int i = 0; i < s.Length;)
        {
            if (s[i] == '\x1b' && i + 1 < s.Length)
            {
                int used = Sequence(s, i, recs);
                if (used > 0) { i += used; continue; }
                Key(recs, s[i + 1], LEFT_ALT_PRESSED); // ESC + key = Alt+key
                i += 2;
                continue;
            }
            if (s[i] == '\x03')
            {
                Flush(recs);
                // cmd and friends want a real Ctrl+C signal; programs reading
                // raw keys (Claude does) want the key itself.
                uint mode;
                GetConsoleMode(conin, out mode);
                if ((mode & ENABLE_PROCESSED_INPUT) != 0) { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0); i++; continue; }
            }
            Key(recs, s[i], 0);
            i++;
        }
        Flush(recs);
    }

    static int Sequence(string s, int i, List<INPUT_RECORD> recs)
    {
        foreach (var kv in Special)
        {
            if (string.CompareOrdinal(s, i, kv.Key, 0, kv.Key.Length) != 0) continue;
            Press(recs, kv.Value, '\0', 0);
            return kv.Key.Length;
        }
        if (string.CompareOrdinal(s, i, "\x1b[Z", 0, 3) == 0) { Press(recs, 0x09, '\t', SHIFT_PRESSED); return 3; }
        // Arrows/Home/End with Shift, Alt or Ctrl: ESC [ 1 ; <mods+1> <key>
        if (i + 5 < s.Length && string.CompareOrdinal(s, i, "\x1b[1;", 0, 4) == 0)
        {
            int m = s[i + 4] - '1';
            int k = "ABCDHF".IndexOf(s[i + 5]);
            if (m >= 0 && m <= 7 && k >= 0)
            {
                uint mods = ((m & 1) != 0 ? SHIFT_PRESSED : 0) | ((m & 2) != 0 ? LEFT_ALT_PRESSED : 0) | ((m & 4) != 0 ? LEFT_CTRL_PRESSED : 0);
                Press(recs, new ushort[] { 0x26, 0x28, 0x27, 0x25, 0x24, 0x23 }[k], '\0', mods);
                return 6;
            }
        }
        return 0;
    }

    static void Key(List<INPUT_RECORD> recs, char c, uint mods)
    {
        if (c == '\r' || c == '\n') Press(recs, 0x0D, '\r', mods);
        else if (c == '\x7f') Press(recs, 0x08, '\b', mods);
        else if (c == '\b') Press(recs, 0x08, '\x7f', mods | LEFT_CTRL_PRESSED); // xterm's Ctrl+Backspace: delete a word
        else if (c == '\t') Press(recs, 0x09, '\t', mods);
        else if (c == '\x1b') Press(recs, 0x1B, '\x1b', mods);
        else if (c < ' ') Press(recs, (ushort)(c + 0x40), c, mods | LEFT_CTRL_PRESSED); // Ctrl+letter
        else
        {
            short scan = VkKeyScan(c);
            ushort vk = scan == -1 ? (ushort)0 : (ushort)(scan & 0xFF);
            if (scan != -1 && (scan & 0x100) != 0) mods |= SHIFT_PRESSED;
            Press(recs, vk, c, mods);
        }
    }

    static void Press(List<INPUT_RECORD> recs, ushort vk, char c, uint mods)
    {
        var r = new INPUT_RECORD
        {
            EventType = KEY_EVENT, RepeatCount = 1, VirtualKeyCode = vk,
            VirtualScanCode = (ushort)MapVirtualKey(vk, 0), UnicodeChar = c, ControlKeyState = mods,
        };
        r.KeyDown = 1;
        recs.Add(r);
        r.KeyDown = 0;
        recs.Add(r);
    }

    static void Flush(List<INPUT_RECORD> recs)
    {
        if (recs.Count == 0) return;
        uint written;
        WriteConsoleInput(conin, recs.ToArray(), (uint)recs.Count, out written);
        recs.Clear();
    }

    // ------------------------------------------------------------ Win32

    const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3;
    const int COMMON_LVB_TRAILING_BYTE = 0x200, COMMON_LVB_REVERSE_VIDEO = 0x4000, COMMON_LVB_UNDERSCORE = 0x8000;
    const ushort KEY_EVENT = 1;
    const uint SHIFT_PRESSED = 0x10, LEFT_CTRL_PRESSED = 0x08, LEFT_ALT_PRESSED = 0x02;
    const uint ENABLE_PROCESSED_INPUT = 0x1, CTRL_C_EVENT = 0;
    const uint SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
    const uint FF_MODERN = 0x30, TMPF_VECTOR = 0x2, TMPF_TRUETYPE = 0x4;

    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CONSOLE_FONT_INFOEX
    {
        public uint cbSize, nFont;
        public COORD dwFontSize;
        public uint FontFamily, FontWeight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FaceName;
    }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct CONSOLE_SCREEN_BUFFER_INFO { public COORD dwSize, dwCursorPosition; public ushort wAttributes; public SMALL_RECT srWindow; public COORD dwMaximumWindowSize; }
    [StructLayout(LayoutKind.Sequential)] struct CONSOLE_CURSOR_INFO { public uint dwSize; public bool bVisible; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct CHAR_INFO { public char UnicodeChar; public ushort Attributes; }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public int KeyDown;
        [FieldOffset(8)] public ushort RepeatCount;
        [FieldOffset(10)] public ushort VirtualKeyCode;
        [FieldOffset(12)] public ushort VirtualScanCode;
        [FieldOffset(14)] public char UnicodeChar;
        [FieldOffset(16)] public uint ControlKeyState;
    }

    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScan(char c);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] list, uint count);
    [DllImport("kernel32.dll")] static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
    [DllImport("kernel32.dll")] static extern bool GetConsoleCursorInfo(IntPtr h, out CONSOLE_CURSOR_INFO info);
    [DllImport("kernel32.dll")] static extern COORD GetLargestConsoleWindowSize(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool GetCurrentConsoleFontEx(IntPtr h, bool max, ref CONSOLE_FONT_INFOEX font);
    [DllImport("kernel32.dll")] static extern bool SetCurrentConsoleFontEx(IntPtr h, bool max, ref CONSOLE_FONT_INFOEX font);
    [DllImport("kernel32.dll")] static extern bool SetConsoleScreenBufferSize(IntPtr h, COORD size);
    [DllImport("kernel32.dll")] static extern bool SetConsoleWindowInfo(IntPtr h, bool absolute, ref SMALL_RECT rect);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "ReadConsoleOutputW")]
    static extern bool ReadConsoleOutput(IntPtr h, [Out] CHAR_INFO[] buf, COORD size, COORD at, ref SMALL_RECT region);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "WriteConsoleInputW")]
    static extern bool WriteConsoleInput(IntPtr h, INPUT_RECORD[] recs, uint count, out uint written);
}
