// The native benchmark fixture for Windows: a WinForms app that writes its own state to a JSON file.
// Built by build.ps1 with PowerShell's Add-Type (the C# 5 compiler of .NET Framework: no newer syntax here).
//
//   BenchFixture.exe --state <file> [--mode dialog|editor] [--pos x,y] [--title <text>] [--selftest [--do "name=..;click=apply"]]
//
// --do runs a task's scripted actions in the self-test (off screen, never activated), one token per action:
//   name=<text>  email=<text>  priority=<Low|Normal|High>  subscribe=<on|off>  text=<text, \n for a line break>
//   click=<apply|delete|modalOk|modalCancel|billingEdit|shippingEdit|mainOk|mainCancel>
//
// The same controls, names and state keys as the macOS (BenchFixture.swift) and Linux (bench_fixture.py) fixtures.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("BenchFixture")]
[assembly: AssemblyProduct("BenchFixture")]

public class Recorder
{
    public readonly Dictionary<string, object> State = new Dictionary<string, object>();
    private readonly List<string> events = new List<string>();
    private readonly string path;

    public Recorder(string path) { this.path = path; }

    public void Event(string type, string target)
    {
        long t = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        events.Add("{\"t\":" + t.ToString(CultureInfo.InvariantCulture) + ",\"type\":" + Quote(type) + ",\"target\":" + Quote(target) + "}");
        Write();
    }

    public void Write()
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"state\":");
        Value(sb, State);
        sb.Append(",\"events\":[").Append(string.Join(",", events.ToArray())).Append("]}");
        // Written beside the file and moved over it: a reader never sees half a file.
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
        if (File.Exists(path)) File.Delete(path);
        File.Move(tmp, path);
    }

    private static void Value(StringBuilder sb, object v)
    {
        if (v == null) sb.Append("null");
        else if (v is bool) sb.Append((bool)v ? "true" : "false");
        else if (v is int) sb.Append(((int)v).ToString(CultureInfo.InvariantCulture));
        else if (v is Dictionary<string, object>)
        {
            sb.Append("{");
            bool first = true;
            foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)v)
            {
                if (!first) sb.Append(",");
                first = false;
                sb.Append(Quote(kv.Key)).Append(":");
                Value(sb, kv.Value);
            }
            sb.Append("}");
        }
        else sb.Append(Quote(v.ToString()));
    }

    private static string Quote(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append("\"").ToString();
    }
}

// Raw input, before any control handles it: a click on empty space or a key no control uses still reached the app, and the
// scorer must not call the action that sent it a false success.
public class RawInput : IMessageFilter
{
    private readonly Recorder rec;
    private DateTime lastMove = DateTime.MinValue;

    public RawInput(Recorder rec) { this.rec = rec; }

    public bool PreFilterMessage(ref Message m)
    {
        switch (m.Msg)
        {
            case 0x0201: case 0x0204: case 0x0207: rec.Event("mouse", "raw"); break;   // left, right, middle button down
            case 0x0100: case 0x0104: rec.Event("key", "raw"); break;                  // key down, system key down
            case 0x020A: case 0x020E: rec.Event("wheel", "raw"); break;                // wheel, horizontal wheel
            case 0x0200:                                                               // mouse move, at most four a second
                if ((DateTime.UtcNow - lastMove).TotalMilliseconds > 250) { lastMove = DateTime.UtcNow; rec.Event("move", "raw"); }
                break;
        }
        return false;   // never swallowed: the app handles it as usual
    }
}

// A form that can be shown without taking the focus (the self-test never activates a window).
public class QuietForm : Form
{
    public bool Quiet;
    protected override bool ShowWithoutActivation { get { return Quiet; } }
}

public class ConfirmForm : QuietForm
{
    public readonly Button Ok = new Button();
    public readonly Button CancelB = new Button();

    public ConfirmForm(Recorder rec)
    {
        Text = "Confirm delete";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false;
        ClientSize = new Size(300, 110);
        Label msg = new Label();
        msg.Text = "Delete the selected record?";
        msg.SetBounds(16, 16, 268, 24);
        Ok.Text = "OK"; Ok.Name = "modalOk"; Ok.SetBounds(60, 60, 80, 28);
        CancelB.Text = "Cancel"; CancelB.Name = "modalCancel"; CancelB.SetBounds(160, 60, 80, 28);
        Controls.Add(msg); Controls.Add(Ok); Controls.Add(CancelB);
        Ok.Click += delegate { rec.State["modalResult"] = "ok"; rec.State["modalOpen"] = false; rec.Event("click", "modalOk"); Close(); };
        CancelB.Click += delegate { rec.State["modalResult"] = "cancel"; rec.State["modalOpen"] = false; rec.Event("click", "modalCancel"); Close(); };
        FormClosed += delegate { if ((bool)rec.State["modalOpen"]) { rec.State["modalOpen"] = false; rec.Event("close", "modal"); } };
    }
}

public class DialogForm : QuietForm
{
    private readonly Recorder rec;
    public readonly TextBox NameBox = new TextBox();
    public readonly TextBox EmailBox = new TextBox();
    public readonly ListBox Priority = new ListBox();
    public readonly CheckBox Subscribe = new CheckBox();
    public readonly Button BillingEdit = new Button();
    public readonly Button ShippingEdit = new Button();
    public readonly Button Delete = new Button();
    public readonly Button Apply = new Button();
    public readonly Button MainOk = new Button();
    public readonly Button MainCancel = new Button();
    public ConfirmForm Confirm;

    public DialogForm(Recorder rec)
    {
        this.rec = rec;
        Text = "Bench Dialog";
        ClientSize = new Size(420, 400);
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;

        AddLabel("Name:", 16, 18);
        NameBox.Name = "name"; NameBox.AccessibleName = "Name"; NameBox.SetBounds(100, 14, 300, 24);
        AddLabel("Email:", 16, 50);
        EmailBox.Name = "email"; EmailBox.AccessibleName = "Email"; EmailBox.SetBounds(100, 46, 300, 24);
        AddLabel("Priority:", 16, 82);
        Priority.Name = "priority"; Priority.AccessibleName = "Priority"; Priority.SetBounds(100, 78, 300, 56);
        Priority.Items.AddRange(new object[] { "Low", "Normal", "High" });
        Subscribe.Name = "subscribe"; Subscribe.Text = "Subscribe"; Subscribe.SetBounds(100, 140, 200, 24);

        // Two buttons with the same name: only the group tells them apart.
        GroupBox billing = new GroupBox(); billing.Text = "Billing"; billing.SetBounds(16, 172, 190, 64);
        BillingEdit.Text = "Edit"; BillingEdit.Name = "billingEdit"; BillingEdit.SetBounds(16, 24, 80, 28);
        billing.Controls.Add(BillingEdit);
        GroupBox shipping = new GroupBox(); shipping.Text = "Shipping"; shipping.SetBounds(214, 172, 190, 64);
        ShippingEdit.Text = "Edit"; ShippingEdit.Name = "shippingEdit"; ShippingEdit.SetBounds(16, 24, 80, 28);
        shipping.Controls.Add(ShippingEdit);

        Delete.Text = "Delete..."; Delete.Name = "delete"; Delete.SetBounds(16, 252, 100, 28);
        Apply.Text = "Apply"; Apply.Name = "apply"; Apply.SetBounds(130, 350, 80, 28);
        // OK and Cancel exist here and in the modal dialog.
        MainOk.Text = "OK"; MainOk.Name = "mainOk"; MainOk.SetBounds(224, 350, 80, 28);
        MainCancel.Text = "Cancel"; MainCancel.Name = "mainCancel"; MainCancel.SetBounds(318, 350, 80, 28);

        Controls.AddRange(new Control[] { NameBox, EmailBox, Priority, Subscribe, billing, shipping, Delete, Apply, MainOk, MainCancel });

        rec.State["name"] = ""; rec.State["email"] = ""; rec.State["priority"] = null; rec.State["subscribe"] = false;
        rec.State["applied"] = null; rec.State["billingEdit"] = 0; rec.State["shippingEdit"] = 0;
        rec.State["mainOk"] = 0; rec.State["mainCancel"] = 0; rec.State["modalOpen"] = false; rec.State["modalResult"] = null;

        NameBox.TextChanged += delegate { rec.State["name"] = NameBox.Text; rec.Event("input", "name"); };
        EmailBox.TextChanged += delegate { rec.State["email"] = EmailBox.Text; rec.Event("input", "email"); };
        Priority.SelectedIndexChanged += delegate { rec.State["priority"] = Priority.SelectedItem == null ? null : Priority.SelectedItem.ToString(); rec.Event("select", "priority"); };
        Subscribe.CheckedChanged += delegate { rec.State["subscribe"] = Subscribe.Checked; rec.Event("toggle", "subscribe"); };
        Count(BillingEdit, "billingEdit"); Count(ShippingEdit, "shippingEdit"); Count(MainOk, "mainOk"); Count(MainCancel, "mainCancel");
        Apply.Click += delegate
        {
            Dictionary<string, object> a = new Dictionary<string, object>();
            a["name"] = NameBox.Text.Trim(); a["email"] = EmailBox.Text.Trim();
            a["priority"] = rec.State["priority"]; a["subscribe"] = Subscribe.Checked;
            rec.State["applied"] = a;
            rec.Event("click", "apply");
        };
        Delete.Click += delegate
        {
            rec.State["modalOpen"] = true;
            rec.Event("click", "delete");
            Confirm = new ConfirmForm(rec);
            Confirm.StartPosition = FormStartPosition.Manual;
            Confirm.Location = new Point(Location.X + 60, Location.Y + 140);
            if (Quiet) { Confirm.Quiet = true; Confirm.Show(); }
            else Confirm.ShowDialog(this);
        };
        Activated += delegate { rec.Event("focus", "window"); };
        foreach (Control c in new Control[] { NameBox, EmailBox, Priority, Subscribe, BillingEdit, ShippingEdit, Delete, Apply, MainOk, MainCancel })
        {
            Control ctl = c;
            ctl.Enter += delegate { rec.Event("focus", ctl.Name); };
        }
    }

    private void AddLabel(string text, int x, int y)
    {
        Label l = new Label(); l.Text = text; l.SetBounds(x, y, 80, 20);
        Controls.Add(l);
    }

    private void Count(Button b, string key)
    {
        b.Click += delegate { rec.State[key] = (int)rec.State[key] + 1; rec.Event("click", key); };
    }
}

public class EditorForm : QuietForm
{
    public readonly TextBox Document = new TextBox();

    public EditorForm(Recorder rec)
    {
        Text = "Bench Editor";
        ClientSize = new Size(520, 360);
        Document.Name = "document"; Document.AccessibleName = "Document";
        Document.Multiline = true; Document.AcceptsReturn = true; Document.AcceptsTab = true;
        Document.ScrollBars = ScrollBars.Vertical; Document.Dock = DockStyle.Fill;
        Document.Font = new Font("Consolas", 11);
        Controls.Add(Document);
        rec.State["text"] = "";
        Document.TextChanged += delegate { rec.State["text"] = Document.Text.Replace("\r\n", "\n"); rec.Event("input", "document"); };
        Document.Enter += delegate { rec.Event("focus", "document"); };
        Activated += delegate { rec.Event("focus", "window"); };
    }
}

public static class BenchFixture
{
    [STAThread]
    public static int Main(string[] args)
    {
        string state = null, mode = "dialog";
        Point pos = new Point(120, 120);
        bool selftest = false;
        string script = null;
        string title = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--state" && i + 1 < args.Length) state = args[++i];
            else if (args[i] == "--mode" && i + 1 < args.Length) mode = args[++i];
            else if (args[i] == "--pos" && i + 1 < args.Length)
            {
                string[] xy = args[++i].Split(',');
                pos = new Point(int.Parse(xy[0], CultureInfo.InvariantCulture), int.Parse(xy[1], CultureInfo.InvariantCulture));
            }
            else if (args[i] == "--selftest") selftest = true;
            else if (args[i] == "--do" && i + 1 < args.Length) script = args[++i];
            else if (args[i] == "--title" && i + 1 < args.Length) title = args[++i];
        }
        if (state == null || (mode != "dialog" && mode != "editor")) return 2;

        Application.EnableVisualStyles();
        Recorder rec = new Recorder(state);
        QuietForm form = mode == "editor" ? (QuietForm)new EditorForm(rec) : new DialogForm(rec);
        form.StartPosition = FormStartPosition.Manual;
        if (title != null) form.Text = title;   // only the fence check uses this: a second window with a look-alike title
        form.Location = pos;
        rec.Write();
        if (!selftest) { Application.AddMessageFilter(new RawInput(rec)); Application.Run(form); return 0; }

        // Self-test: off screen, never activated, driven through the controls' own handlers, then closed.
        form.Quiet = true;
        form.ShowInTaskbar = false;
        form.Location = new Point(-32000, -32000);
        form.Show();
        if (script != null)
        {
            // A task's scripted actions, through the same handlers a click or a keystroke reaches. An unknown token is an error.
            foreach (string token in script.Split(';'))
            {
                int eq = token.IndexOf('=');
                if (eq <= 0 || !Do(form, token.Substring(0, eq).Trim(), token.Substring(eq + 1))) { form.Close(); return 3; }
                Application.DoEvents();
            }
        }
        else if (mode == "editor")
        {
            ((EditorForm)form).Document.Text = "first line\r\nsecond line";
        }
        else
        {
            DialogForm d = (DialogForm)form;
            d.NameBox.Text = "Self Test";
            d.EmailBox.Text = "self@test.example";
            d.Priority.SelectedIndex = 2;
            d.Subscribe.Checked = true;
            d.ShippingEdit.PerformClick();
            d.Apply.PerformClick();
            d.Delete.PerformClick();
            d.Confirm.Ok.PerformClick();
        }
        Application.DoEvents();
        form.Close();
        return 0;
    }

    private static bool Do(QuietForm form, string key, string value)
    {
        EditorForm e = form as EditorForm;
        if (e != null)
        {
            if (key != "text") return false;
            e.Document.Text = value.Replace("\\n", "\r\n");
            return true;
        }
        DialogForm d = (DialogForm)form;
        switch (key)
        {
            case "name": d.NameBox.Text = value; return true;
            case "email": d.EmailBox.Text = value; return true;
            case "priority":
                int at = d.Priority.Items.IndexOf(value);
                if (at < 0) return false;
                d.Priority.SelectedIndex = at;
                return true;
            case "subscribe": d.Subscribe.Checked = value == "on"; return true;
            case "click":
                Button b = value == "apply" ? d.Apply : value == "delete" ? d.Delete : value == "billingEdit" ? d.BillingEdit
                    : value == "shippingEdit" ? d.ShippingEdit : value == "mainOk" ? d.MainOk : value == "mainCancel" ? d.MainCancel
                    : value == "modalOk" && d.Confirm != null ? d.Confirm.Ok : value == "modalCancel" && d.Confirm != null ? d.Confirm.CancelB : null;
                if (b == null) return false;
                b.PerformClick();
                return true;
            default: return false;
        }
    }
}
