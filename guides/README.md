# ClawdCursor App Guides

Community-driven instruction manuals for desktop applications. These guides teach ClawdCursor's AI how to efficiently operate each app — keyboard shortcuts, workflows, UI layout, and common pitfalls.

## How It Works

When ClawdCursor detects the active application (via process name), it loads the matching guide and injects it into the AI's context. The AI then knows the most efficient way to accomplish tasks in that app.

## Guide Format

Each guide is a JSON file named `{process-name}.json`:

```json
{
  "app": "Microsoft Excel",
  "processNames": ["EXCEL", "excel"],
  "workflows": {
    "create_table": "Click cell A1. Type headers with Tab between columns. Press Enter for next row. Type data with Tab between columns.",
    "save_as": "Press Ctrl+Shift+S. Navigate to folder. Type filename. Click Save."
  },
  "shortcuts": {
    "new_workbook": "Ctrl+N",
    "save": "Ctrl+S",
    "save_as": "Ctrl+Shift+S",
    "next_cell": "Tab",
    "next_row": "Enter",
    "select_all": "Ctrl+A"
  },
  "layout": {
    "ribbon": "Top toolbar with tabs (Home, Insert, Page Layout, etc.)",
    "workspace": "Grid of cells below the ribbon — this is where you type data",
    "formula_bar": "Below ribbon, shows cell contents"
  },
  "tips": [
    "For simple tables, just type directly into cells. Don't use Insert > Table.",
    "Tab moves right, Enter moves down. Shift+Tab moves left.",
    "The workspace (cell grid) is the large area below the ribbon."
  ]
}
```

## Contributing

1. Create a `{process-name}.json` file in this directory
2. Use the process name from Windows Task Manager (e.g., `EXCEL`, `mspaint`, `notepad`)
3. Focus on EFFICIENT workflows — keyboard shortcuts over mouse clicks
4. Include layout hints so the AI knows where UI areas are
5. Submit a PR

## Loaded Automatically

Guides are loaded at task time based on the active window's process name. No code changes needed — just add a JSON file.
