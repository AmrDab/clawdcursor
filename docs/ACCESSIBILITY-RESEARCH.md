# Windows UI Automation from Node.js — Research Report

**Date:** 2026-02-19  
**Context:** clawdcursor desktop AI agent currently uses VNC + screenshot + vision for every action.  
**Goal:** Add a Windows accessibility layer to enumerate UI elements, read properties, and interact by reference (not pixel coordinates).

---

## Table of Contents

1. [Background: Windows UI Automation APIs](#1-background-windows-ui-automation-apis)
2. [Option A: PowerShell Bridge (spawn child process)](#2-option-a-powershell-bridge-spawn-child-process)
3. [Option B: @bright-fish/node-ui-automation (native NAPI addon)](#3-option-b-bright-fishnode-ui-automation-native-napi-addon)
4. [Option C: edge-js (.NET bridge)](#4-option-c-edge-js-net-bridge)
5. [Option D: nut.js + element-inspector plugin](#5-option-d-nutjs--element-inspector-plugin)
6. [Option E: Appium + WinAppDriver](#6-option-e-appium--winappdriver)
7. [Option F: NodeRT WinRT bindings](#7-option-f-nodert-winrt-bindings)
8. [Option G: Custom C++ NAPI addon](#8-option-g-custom-c-napi-addon)
9. [Option H: Python subprocess (pywinauto)](#9-option-h-python-subprocess-pywinauto)
10. [Comparison Matrix](#10-comparison-matrix)
11. [Recommended Approach](#11-recommended-approach)
12. [MVP Implementation Plan](#12-mvp-implementation-plan)

---

## 1. Background: Windows UI Automation APIs

Windows exposes two main accessibility APIs:

- **Microsoft UI Automation (UIA)** — The modern API (COM-based, `IUIAutomation` interface). Supports Win32, WinForms, WPF, UWP, and many third-party apps. This is what we want to target.
- **MSAA (Microsoft Active Accessibility)** — Legacy API, still supported but less capable.

Both expose a **tree of automation elements** rooted at the desktop. Each element has:
- **Name** — human-readable label (e.g. "Save" button)
- **AutomationId** — developer-assigned stable identifier
- **ControlType** — Button, Edit, MenuItem, TreeItem, etc.
- **ClassName** — Win32 class name
- **BoundingRectangle** — screen coordinates {x, y, width, height}
- **Patterns** — InvokePattern (click), ValuePattern (get/set text), SelectionPattern, etc.

The key insight: **UIA is a COM API**. Node.js can't call COM directly. Every approach below is a different bridge to get from Node.js → COM UIA calls.

---

## 2. Option A: PowerShell Bridge (spawn child process)

### How It Works
Spawn `powershell.exe` from Node.js, run a script that uses .NET's `System.Windows.Automation` namespace (built into .NET Framework on every Windows machine), and return JSON.

### Code Example

**PowerShell script (`get-ui-tree.ps1`):**
```powershell
param(
    [int]$ProcessId,
    [int]$MaxDepth = 3
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement

function Get-UITree {
    param($element, $depth = 0)
    
    if ($depth -ge $MaxDepth) { return $null }
    
    $current = $element.Current
    $rect = $current.BoundingRectangle
    
    $node = @{
        name = $current.Name
        automationId = $current.AutomationId
        controlType = $current.ControlType.ProgrammaticName
        className = $current.ClassName
        bounds = @{
            x = [int]$rect.X
            y = [int]$rect.Y
            width = [int]$rect.Width
            height = [int]$rect.Height
        }
        isEnabled = $current.IsEnabled
        children = @()
    }
    
    try {
        $children = $element.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        foreach ($child in $children) {
            $childNode = Get-UITree -element $child -depth ($depth + 1)
            if ($childNode) { $node.children += $childNode }
        }
    } catch {}
    
    return $node
}

if ($ProcessId) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId
    )
    $targetWindow = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($targetWindow) {
        $tree = Get-UITree -element $targetWindow
        $tree | ConvertTo-Json -Depth 20 -Compress
    }
} else {
    # Get all top-level windows
    $windows = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    $result = @()
    foreach ($win in $windows) {
        $c = $win.Current
        if ($c.Name) {
            $result += @{
                name = $c.Name
                processId = $c.ProcessId
                automationId = $c.AutomationId
                className = $c.ClassName
            }
        }
    }
    $result | ConvertTo-Json -Compress
}
```

**PowerShell action script (`invoke-element.ps1`):**
```powershell
param(
    [int]$ProcessId,
    [string]$AutomationId,
    [string]$Name,
    [string]$Action = "invoke",  # invoke, setValue, focus
    [string]$Value
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$procCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId
)
$window = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $procCondition)

$condition = if ($AutomationId) {
    New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId
    )
} else {
    New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $Name
    )
}

$element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)

switch ($Action) {
    "invoke" {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        @{ success = $true } | ConvertTo-Json
    }
    "setValue" {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $pattern.SetValue($Value)
        @{ success = $true } | ConvertTo-Json
    }
    "focus" {
        $element.SetFocus()
        @{ success = $true } | ConvertTo-Json
    }
    "getText" {
        $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        @{ success = $true; value = $pattern.Current.Value } | ConvertTo-Json
    }
}
```

**Node.js wrapper:**
```typescript
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface UIElement {
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  bounds: { x: number; y: number; width: number; height: number };
  isEnabled: boolean;
  children: UIElement[];
}

export class WindowsAccessibility {
  private scriptsDir: string;

  constructor(scriptsDir: string) {
    this.scriptsDir = scriptsDir;
  }

  async getUITree(processId: number, maxDepth = 3): Promise<UIElement> {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${this.scriptsDir}/get-ui-tree.ps1`,
      '-ProcessId', String(processId),
      '-MaxDepth', String(maxDepth),
    ], { timeout: 10000 });
    return JSON.parse(stdout.trim());
  }

  async listWindows(): Promise<{ name: string; processId: number }[]> {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${this.scriptsDir}/get-ui-tree.ps1`,
    ], { timeout: 10000 });
    return JSON.parse(stdout.trim());
  }

  async clickElement(processId: number, opts: { automationId?: string; name?: string }): Promise<void> {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${this.scriptsDir}/invoke-element.ps1`,
      '-ProcessId', String(processId),
      ...(opts.automationId ? ['-AutomationId', opts.automationId] : []),
      ...(opts.name ? ['-Name', opts.name] : []),
      '-Action', 'invoke',
    ], { timeout: 10000 });
  }

  async setElementValue(processId: number, opts: { automationId?: string; name?: string }, value: string): Promise<void> {
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${this.scriptsDir}/invoke-element.ps1`,
      '-ProcessId', String(processId),
      ...(opts.automationId ? ['-AutomationId', opts.automationId] : []),
      ...(opts.name ? ['-Name', opts.name] : []),
      '-Action', 'setValue',
      '-Value', value,
    ], { timeout: 10000 });
  }
}
```

### Pros
- ✅ **Zero native dependencies** — no compilation, no C++ toolchain needed
- ✅ **Works on every Windows machine** — `UIAutomationClient` is built into .NET Framework
- ✅ **Full UIA API access** — all patterns, properties, and tree walking
- ✅ **Easy to debug** — run PowerShell scripts standalone
- ✅ **Fastest MVP** — can be built in a few hours
- ✅ **No version compatibility issues** — no native addon to rebuild per Node.js version

### Cons
- ❌ **Slow** — each call spawns a new `powershell.exe` process (~200-500ms startup overhead)
- ❌ **Serialization overhead** — data round-trips through stdout as JSON
- ❌ **No persistent connection** — can't cache the UIA COM object across calls
- ❌ **Error handling is clunky** — stderr parsing
- ❌ **Not suitable for real-time interaction** — too slow for rapid sequences

### Mitigation for Speed
Use a **long-lived PowerShell process** with stdin/stdout communication:
```typescript
import { spawn } from 'child_process';

class PowerShellBridge {
  private ps: ChildProcess;
  private pendingCallbacks: Map<string, (data: any) => void> = new Map();

  constructor() {
    this.ps = spawn('powershell.exe', ['-NoProfile', '-NoExit', '-Command', '-']);
    this.ps.stdout.on('data', (chunk) => this.handleOutput(chunk.toString()));
  }

  async execute(script: string): Promise<any> {
    const id = crypto.randomUUID();
    const wrapped = `
      try {
        $result = & { ${script} }
        "@@RESULT:${id}:" + ($result | ConvertTo-Json -Compress)
      } catch {
        "@@ERROR:${id}:" + $_.Exception.Message
      }
    `;
    return new Promise((resolve, reject) => {
      this.pendingCallbacks.set(id, resolve);
      this.ps.stdin.write(wrapped + '\n');
    });
  }
}
```

With a persistent PowerShell process, individual calls drop to **~20-50ms** instead of 200-500ms.

---

## 3. Option B: @bright-fish/node-ui-automation (native NAPI addon)

### How It Works
A native C++ Node.js addon that wraps the Microsoft UI Automation COM API directly using N-API. This is the most direct approach — it exposes UIA classes as JavaScript objects.

### Code Example
```typescript
const { Automation, PropertyIds, TreeScopes, PatternIds } = require('@bright-fish/node-ui-automation');

const automation = new Automation();
const desktop = automation.getRootElement();

// Find a window by name
const windowCondition = automation.createPropertyCondition(
  PropertyIds.NamePropertyId, 'About Windows'
);
const window = desktop.findFirst(TreeScopes.Subtree, windowCondition);

// Find and click a button
const okCondition = automation.createPropertyCondition(
  PropertyIds.NamePropertyId, 'OK'
);
const okButton = window.findFirst(TreeScopes.Subtree, okCondition);
const invokePattern = okButton.getCurrentPattern(PatternIds.InvokePatternId);
invokePattern.invoke();

// Get element properties
const name = okButton.getCurrentPropertyValue(PropertyIds.NamePropertyId);
const rect = okButton.getCurrentPropertyValue(PropertyIds.BoundingRectanglePropertyId);
```

### Pros
- ✅ **Fastest possible** — direct COM calls, no process spawning
- ✅ **Full UIA API** — mirrors the COM interface closely
- ✅ **Synchronous & async** — no serialization overhead
- ✅ **Proper TypeScript types** could be added

### Cons
- ❌ **Low maintenance** — last published June 2022, 5 GitHub stars
- ❌ **May not compile on newer Node.js** — N-API should help, but untested on Node 20+
- ❌ **Small community** — limited documentation, few users
- ❌ **Requires C++ build tools** to install (node-gyp, Visual Studio Build Tools)
- ❌ **Windows only** (acceptable for our use case)
- ❌ **Risk of abandonment** — single maintainer

### Verdict
**Best performance, highest risk.** Worth testing if it installs and works on our Node.js version. If it does, it's the ideal solution. If not, we fall back.

---

## 4. Option C: edge-js (.NET Bridge)

### How It Works
[edge-js](https://github.com/agracio/edge-js) lets you call .NET code (C#) in-process from Node.js. You write C# inline or in a DLL, and edge-js marshals data between V8 and CLR.

### Code Example
```typescript
import edge from 'edge-js';

const getUITree = edge.func(`
  #r "UIAutomationClient.dll"
  #r "UIAutomationTypes.dll"

  using System;
  using System.Collections.Generic;
  using System.Threading.Tasks;
  using System.Windows.Automation;

  public class Startup {
    public async Task<object> Invoke(dynamic input) {
      int processId = (int)input.processId;
      int maxDepth = (int)input.maxDepth;
      
      var root = AutomationElement.RootElement;
      var condition = new PropertyCondition(
        AutomationElement.ProcessIdProperty, processId
      );
      var window = root.FindFirst(TreeScope.Children, condition);
      
      return GetTree(window, 0, maxDepth);
    }

    private Dictionary<string, object> GetTree(AutomationElement element, int depth, int maxDepth) {
      if (element == null || depth >= maxDepth) return null;
      
      var current = element.Current;
      var rect = current.BoundingRectangle;
      
      var node = new Dictionary<string, object> {
        { "name", current.Name },
        { "automationId", current.AutomationId },
        { "controlType", current.ControlType.ProgrammaticName },
        { "className", current.ClassName },
        { "bounds", new { x = rect.X, y = rect.Y, width = rect.Width, height = rect.Height } },
        { "isEnabled", current.IsEnabled },
        { "children", new List<object>() }
      };
      
      var children = element.FindAll(TreeScope.Children, Condition.TrueCondition);
      foreach (AutomationElement child in children) {
        var childNode = GetTree(child, depth + 1, maxDepth);
        if (childNode != null)
          ((List<object>)node["children"]).Add(childNode);
      }
      
      return node;
    }
  }
`);

// Usage
const tree = await getUITree({ processId: 12345, maxDepth: 3 });
console.log(JSON.stringify(tree, null, 2));
```

### Pros
- ✅ **In-process .NET execution** — much faster than spawning PowerShell
- ✅ **Full .NET API access** — System.Windows.Automation + FlaUI + any NuGet package
- ✅ **Async-friendly** — returns Promises
- ✅ **Maintained** — edge-js (agracio fork) supports .NET 6/7/8 and recent Node.js
- ✅ **Can use FlaUI** — the best .NET UIA wrapper, much friendlier API than raw UIA

### Cons
- ❌ **Requires .NET runtime** installed (or .NET Framework which is built-in)
- ❌ **Requires C++ build tools** for edge-js compilation
- ❌ **Complex debugging** — errors span two runtimes
- ❌ **Data marshaling** — objects cross the V8↔CLR boundary, which has overhead
- ❌ **Inline C# strings** are hard to maintain (better to use compiled DLLs)

### Recommended Variant: Precompiled .NET DLL
Instead of inline C#, create a small .NET class library:
```bash
dotnet new classlib -n UiaHelper
# Add System.Windows.Automation references
dotnet build
```
Then call it from edge-js by referencing the DLL path.

---

## 5. Option D: nut.js + element-inspector plugin

### How It Works
[nut.js](https://nutjs.dev/) is a cross-platform desktop automation framework for Node.js. Their `@nut-tree/element-inspector` plugin adds Windows UI element inspection using platform accessibility APIs.

### Code Example
```typescript
import { mouse, Button, keyboard, straightTo, centerOf, getActiveWindow } from "@nut-tree/nut-js";
import { useElementInspector } from "@nut-tree/element-inspector";
import { elements } from "@nut-tree/element-inspector/win";

useElementInspector();

// Get the element tree
const window = await getActiveWindow();
const items = await window.getElements(5); // depth limit
console.log(JSON.stringify(items, null, 2));

// Find and click a button by title
const saveBtn = await window.find(elements.button({ title: "Save" }));
await mouse.move(straightTo(centerOf(saveBtn.region)));
await mouse.click(Button.LEFT);

// Find a text field and type
const nameField = await window.find(elements.textField({ title: "Name" }));
await mouse.move(straightTo(centerOf(nameField.region)));
await mouse.click(Button.LEFT);
await keyboard.type("Hello World");

// Hierarchical queries
const menuItem = await window.find(
  elements.menuItem({
    title: "Save As",
    descendantOf: elements.menu({ title: "File" })
  })
);
```

### Element Structure Returned
```typescript
interface WindowElement {
  id?: string;
  type?: string;
  title?: string;
  value?: string;
  role?: string;
  className?: string;
  helpText?: string;
  clickablePoint?: Point;
  region?: Region;
  isFocused?: boolean;
  isEnabled?: boolean;
  isVisible?: boolean;
  isChecked?: boolean;
  children?: WindowElement[];
}
```

### Pros
- ✅ **Polished API** — best developer experience of all options
- ✅ **Cross-platform** — Windows, macOS, Linux
- ✅ **Rich query system** — parent/child, sibling, state matching, regex
- ✅ **Actively maintained** — commercial product with regular updates
- ✅ **Combines mouse/keyboard + accessibility** — one library for everything
- ✅ **TypeScript native**

### Cons
- ❌ **Paid subscription required** — element-inspector is not in the free tier (Solo/Team plans)
- ❌ **Closed source** — the element-inspector plugin is proprietary
- ❌ **Still uses mouse.move + click** — not direct pattern invocation (InvokePattern)
- ❌ **Elements resolve to screen regions** — still coordinate-based clicking under the hood
- ❌ **Can't invoke UIA patterns directly** — no SetValue, no Invoke without mouse
- ❌ **Dependency on commercial vendor**

### Verdict
Good if you want a polished solution and are willing to pay. But it's a leaky abstraction — it finds elements by accessibility, then clicks by coordinates. For a desktop AI agent, we want **direct pattern invocation** (click a button without moving the mouse, set text without keyboard events).

---

## 6. Option E: Appium + WinAppDriver

### How It Works
[WinAppDriver](https://github.com/Microsoft/WinAppDriver) is Microsoft's WebDriver implementation for Windows. It exposes UIA elements through the Selenium/WebDriver JSON Wire Protocol. [Appium](https://appium.io/) can proxy to it.

### Code Example
```typescript
import { remote } from 'webdriverio';

const driver = await remote({
  hostname: '127.0.0.1',
  port: 4723,
  capabilities: {
    platformName: 'Windows',
    'appium:automationName': 'Windows',
    'appium:app': 'Root',  // Attach to desktop root
  }
});

// Find by AutomationId
const button = await driver.$('~CalculatorResults');
const text = await button.getText();

// Find by name
const okBtn = await driver.$('//Button[@Name="OK"]');
await okBtn.click();

// Find by XPath
const menuItem = await driver.$('//MenuItem[@Name="File"]');
await menuItem.click();
```

### Pros
- ✅ **Official Microsoft support** — WinAppDriver is from Microsoft
- ✅ **Selenium/WebDriver API** — familiar if you've used web testing
- ✅ **XPath queries** on the UIA tree
- ✅ **Language-agnostic** — any WebDriver client works
- ✅ **Element screenshots, page source (XML of UIA tree)**

### Cons
- ❌ **Requires WinAppDriver to be running** — separate process to manage
- ❌ **Requires Developer Mode** on Windows
- ❌ **Heavy** — HTTP-based protocol, JSON serialization per call
- ❌ **Slow** — WebDriver protocol adds ~50-100ms per operation
- ❌ **WinAppDriver development seems stalled** — last release was 2021
- ❌ **Overkill for our use case** — designed for test automation, not AI agents
- ❌ **Not suitable for rapid interaction** — too many layers

---

## 7. Option F: NodeRT WinRT Bindings

### How It Works
[NodeRT](https://github.com/NodeRT/NodeRT) auto-generates Node.js bindings for WinRT APIs. The `@nodert-win11/windows.ui.uiautomation` package exposes `Windows.UI.UIAutomation`.

### Important Caveat
The WinRT `Windows.UI.UIAutomation` namespace is **extremely limited** compared to the COM `IUIAutomation` API. The WinRT version only exposes `AutomationElement`, basic properties, and event registration — it does NOT provide:
- `FindAll` / `FindFirst` tree traversal
- Pattern access (InvokePattern, ValuePattern, etc.)
- Condition building
- Most of what we need

### Verdict
**Not suitable.** The WinRT UIAutomation API is a tiny subset intended for accessibility event consumers (screen readers), not for full UI tree inspection and manipulation. The COM API (`IUIAutomation`) is what all serious tools use.

---

## 8. Option G: Custom C++ NAPI Addon

### How It Works
Write a C++ native addon that directly calls `IUIAutomation` COM interfaces and exposes them to Node.js via N-API.

### Skeleton
```cpp
// addon.cpp
#include <napi.h>
#include <UIAutomation.h>
#include <comdef.h>

class UIAutomationWrapper : public Napi::ObjectWrap<UIAutomationWrapper> {
  IUIAutomation* pAutomation;
  
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "UIAutomation", {
      InstanceMethod("getRootElement", &UIAutomationWrapper::GetRootElement),
      InstanceMethod("getUITree", &UIAutomationWrapper::GetUITree),
      InstanceMethod("findElement", &UIAutomationWrapper::FindElement),
      InstanceMethod("invokeElement", &UIAutomationWrapper::InvokeElement),
    });
    exports.Set("UIAutomation", func);
    return exports;
  }

  UIAutomationWrapper(const Napi::CallbackInfo& info) : Napi::ObjectWrap<UIAutomationWrapper>(info) {
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    CoCreateInstance(CLSID_CUIAutomation, NULL, CLSCTX_INPROC_SERVER,
                     IID_IUIAutomation, (void**)&pAutomation);
  }
  
  // ... methods that traverse the UIA tree and return Napi::Objects
};
```

### Pros
- ✅ **Maximum performance** — direct COM calls, zero overhead
- ✅ **Full control** — expose exactly what we need
- ✅ **N-API stability** — binary compatible across Node.js versions

### Cons
- ❌ **Significant development effort** — weeks of C++ work
- ❌ **COM programming is painful** — reference counting, BSTR, VARIANT, error handling
- ❌ **Maintenance burden** — we'd own this code
- ❌ **Build toolchain** — requires Visual Studio / Build Tools

### Verdict
Overkill unless `@bright-fish/node-ui-automation` doesn't work. That package already did this work.

---

## 9. Option H: Python Subprocess (pywinauto)

### How It Works
Spawn Python with [pywinauto](https://github.com/pywinauto/pywinauto), the most mature Windows UI automation library.

```typescript
import { execFile } from 'child_process';

// Python script: get_ui_tree.py
const pythonScript = `
import json, sys
from pywinauto import Desktop

def get_tree(element, depth=0, max_depth=3):
    if depth >= max_depth:
        return None
    props = element.element_info
    node = {
        "name": props.name,
        "control_type": props.control_type,
        "automation_id": props.automation_id,
        "class_name": props.class_name,
        "rectangle": {
            "x": props.rectangle.left,
            "y": props.rectangle.top,
            "width": props.rectangle.width(),
            "height": props.rectangle.height()
        },
        "children": []
    }
    for child in element.children():
        child_node = get_tree(child, depth + 1, max_depth)
        if child_node:
            node["children"].append(child_node)
    return node

pid = int(sys.argv[1])
app = Desktop(backend="uia").window(process=pid)
tree = get_tree(app.wrapper_object())
print(json.dumps(tree))
`;
```

### Pros
- ✅ **pywinauto is the gold standard** — most mature, best documented
- ✅ **Handles edge cases** that other tools miss
- ✅ **Active community** — 5k+ GitHub stars

### Cons
- ❌ **Requires Python installed**
- ❌ **Process spawn overhead** (~500ms-1s with Python startup)
- ❌ **Two runtimes** — adds complexity
- ❌ **Not a natural fit** — we're a Node.js project

---

## 10. Comparison Matrix

| Approach | Setup Effort | Speed | API Coverage | Maintenance Risk | Dependencies |
|----------|-------------|-------|-------------|-----------------|-------------|
| **A: PowerShell** | ⭐ Trivial | 🐌 Slow (200ms+) → ⚡ Fast with persistent PS | ✅ Full UIA | ✅ Low (built-in) | None |
| **B: node-ui-automation** | ⭐⭐ Easy | ⚡ Fastest | ✅ Full UIA | ⚠️ Unmaintained | C++ build tools |
| **C: edge-js** | ⭐⭐⭐ Medium | ⚡ Fast | ✅ Full UIA + FlaUI | ⭐ Good | .NET, C++ build tools |
| **D: nut.js** | ⭐⭐ Easy | ⚡ Fast | ⚠️ Partial (no patterns) | ✅ Commercial | Paid license |
| **E: Appium** | ⭐⭐⭐⭐ Complex | 🐌 Slow | ✅ Full via XPath | ⚠️ Stalled | WinAppDriver, Java |
| **F: NodeRT** | ⭐⭐ Easy | ⚡ Fast | ❌ Very limited | ⚠️ Low | None |
| **G: Custom C++** | ⭐⭐⭐⭐⭐ Hard | ⚡ Fastest | ✅ Full | ❌ We maintain | C++ build tools |
| **H: pywinauto** | ⭐⭐ Easy | 🐌 Slow | ✅ Best | ✅ Excellent | Python |

---

## 11. Recommended Approach

### 🏆 Primary: PowerShell Bridge with Persistent Process (Option A, enhanced)

**Why:**
1. **Zero dependencies** — works on every Windows machine today
2. **Fastest path to MVP** — can be built in 2-4 hours
3. **Full UIA access** — nothing is missing
4. **No build tools** — no node-gyp, no Visual Studio
5. **Easy to test and debug** — run scripts standalone
6. **Matches our architecture** — we already spawn processes (VNC), this is the same pattern

**Performance plan:**
- Start with simple `execFile` calls for the MVP
- Upgrade to persistent PowerShell process with stdin/stdout protocol for production
- With persistent process, individual calls are **20-50ms** — fast enough for an AI agent

### 🥈 Upgrade Path: edge-js + FlaUI (Option C)

Once the MVP proves the accessibility approach works, consider migrating to edge-js with FlaUI for:
- Better performance (in-process .NET calls)
- Richer API (FlaUI is much more ergonomic than raw UIA)
- Pattern invocation without mouse simulation

### 🥉 Worth Testing: @bright-fish/node-ui-automation (Option B)

Before committing to PowerShell, try:
```bash
npm install @bright-fish/node-ui-automation
```
If it installs and works on Node 20+, it may be the best option outright. But don't depend on it without verifying — the package hasn't been updated since 2022.

---

## 12. MVP Implementation Plan

### Phase 1: PowerShell Scripts (Day 1)

Create these files in `src/accessibility/`:

```
src/accessibility/
├── scripts/
│   ├── get-windows.ps1      # List all windows with PID, name, bounds
│   ├── get-ui-tree.ps1      # Get UI tree for a process (JSON)
│   ├── find-element.ps1     # Find element by name/automationId
│   ├── invoke-element.ps1   # Click/invoke an element
│   └── set-value.ps1        # Set text in an element
├── windows-accessibility.ts  # Node.js wrapper class
└── types.ts                  # TypeScript interfaces
```

### Phase 2: Integrate with Agent (Day 2)

Modify the agent loop to:
1. **Before taking a screenshot**, query the UI tree for the target window
2. **Pass the UI tree as text** to the AI brain alongside (or instead of) the screenshot
3. **Let the AI choose**: click by element reference OR by coordinates
4. **Execute**: if element reference → use PowerShell invoke; if coordinates → use VNC click

### Phase 3: Persistent PowerShell Process (Day 3)

Upgrade from `execFile` to a long-lived PowerShell process with a simple JSON-RPC protocol over stdin/stdout.

### Hybrid Architecture

```
┌─────────────┐
│   AI Brain   │
│  (decides    │
│   actions)   │
└──────┬───────┘
       │ "click element 'Save' button"
       │   OR
       │ "click at (500, 300)"
       ▼
┌─────────────┐     ┌──────────────────┐
│    Agent     │────▶│  Accessibility   │ ← NEW
│  Orchestrator│     │  Layer (PS/UIA)  │
│              │     │  - getUITree()   │
│              │     │  - clickElement()│
│              │     │  - setText()     │
└──────┬───────┘     └──────────────────┘
       │
       ▼
┌─────────────┐
│  VNC Client  │ ← existing (fallback for pixel-based actions)
│  - screenshot│
│  - mouse     │
│  - keyboard  │
└─────────────┘
```

The AI gets **both** the UI tree (structured data) and a screenshot (visual context). It can then make smarter, faster decisions:
- "I see a 'Save' button with AutomationId 'btnSave' → invoke it directly" (no screenshot needed)
- "This is a custom-drawn canvas with no accessibility → fall back to screenshot + coordinates"

---

## Appendix: Useful Tools for Development

### Inspect.exe (Windows SDK)
Part of the Windows SDK. Lets you hover over any element and see its UIA properties. Essential for development.
```
C:\Program Files (x86)\Windows Kits\10\bin\<version>\x64\inspect.exe
```

### Accessibility Insights for Windows
Free Microsoft tool. Better UI than Inspect.exe. Download from: https://accessibilityinsights.io/

### FlaUInspect
Open-source UIA tree viewer. Install via:
```bash
choco install flauinspect
```

---

## Appendix: Key UIA Control Types

| ControlType | Description | Common Patterns |
|------------|-------------|----------------|
| Button | Clickable button | InvokePattern |
| Edit | Text input field | ValuePattern, TextPattern |
| Text | Static text label | (read-only) |
| MenuItem | Menu item | InvokePattern, ExpandCollapsePattern |
| ComboBox | Dropdown | SelectionPattern, ExpandCollapsePattern |
| CheckBox | Checkbox | TogglePattern |
| RadioButton | Radio button | SelectionItemPattern |
| TreeItem | Tree node | ExpandCollapsePattern, SelectionItemPattern |
| ListItem | List item | SelectionItemPattern |
| Tab | Tab control | SelectionPattern |
| Window | Application window | WindowPattern |
| Pane | Container pane | ScrollPattern |

---

## Appendix: Reference Links

- [Microsoft UIA Documentation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)
- [System.Windows.Automation Namespace (.NET)](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation)
- [@bright-fish/node-ui-automation](https://github.com/bright-fish/node-ui-automation)
- [edge-js](https://github.com/agracio/edge-js)
- [FlaUI](https://github.com/FlaUI/FlaUI)
- [nut.js element-inspector](https://nutjs.dev/plugins/element-inspector)
- [WinAppDriver](https://github.com/Microsoft/WinAppDriver)
- [pywinauto](https://github.com/pywinauto/pywinauto)
- [NodeRT](https://github.com/NodeRT/NodeRT)
- [Microsoft UI UIAutomation (Remote Operations)](https://github.com/microsoft/Microsoft-UI-UIAutomation)
