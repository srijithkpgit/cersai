# Cersai - CERT-C AI Analyzer

AI-powered triage of CERT-C, MISRA C, and QAC static analysis warnings. Reads an Excel report, analyzes each warning against your source code using GitHub Copilot, and writes back a priority classification with a detailed justification.

**Cer**t + **S**can + **AI** = **Cersai**

---

## Prerequisites

1. **VS Code** 1.91.0 or later
2. **GitHub Copilot** extension installed and signed in with an active subscription
3. **Node.js** 18+ (only needed if building from source)

---

## Installation

### Option A - Install from VS Code Marketplace

1. Open VS Code
2. Go to the Extensions panel (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **"Cersai"**
4. Click **Install**

### Option B - Install from .vsix file

1. Open VS Code
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) to open the Command Palette
3. Type **"Install from VSIX"** and select `Extensions: Install from VSIX...`
4. Browse to and select the `cersai-0.1.0.vsix` file
5. Reload VS Code when prompted

### Option C - Build from source

```bash
git clone https://github.com/YOUR_USERNAME/cersai.git
cd cersai
npm install
npm run package
code --install-extension cersai-0.1.0.vsix
```

After installing, reload VS Code. You will see a **shield icon** in the Activity Bar (left sidebar) - that is the Cersai panel.

---

## Quick Start

1. Click the **shield icon** in the Activity Bar to open the Cersai panel
2. Click **Browse** next to "Excel Report" and select your `.xlsx` file containing static analysis warnings
3. Click **Browse** next to "Project Folder" and select the root folder of your C source code
4. Adjust settings if needed (defensiveness level, auto-fix, skip analyzed)
5. Click **Start Analysis**

The extension will process each warning, show progress in real-time, and write results (Priority + Comment) back into your Excel file.

---

## Excel File Format

Your Excel file must have a header row with these columns (name matching is case-insensitive):

| Column        | Description                              |
|---------------|------------------------------------------|
| **Message**       | The warning message (e.g., `EXP33-C: ...`) |
| **Path**          | Source file path (relative or absolute)  |
| **Line-in-Code**  | Line number where the warning occurs     |
| **Column**        | Column number (optional but expected)    |
| **Code-Line**     | The actual line of source code           |

The extension will create or update two additional columns:

| Column     | Description                                     |
|------------|-------------------------------------------------|
| **Priority**   | `HIGH_PRIO`, `LOW_PRIO`, or `FALSE_POSITIVE`    |
| **Comment**    | Detailed 6-step analysis with justification     |

---

## Features

- **AI-Powered Analysis** - Uses GitHub Copilot via VS Code's Language Model API
- **2-Pass Verification** - Every non-critical result is automatically challenged by an adversarial review pass to catch missed issues
- **3 Priority Levels** - HIGH_PRIO (needs fix), LOW_PRIO (valid but safe), FALSE_POSITIVE (not applicable)
- **Defensiveness Slider** - Relaxed / Neutral / Strict analysis modes
- **Auto-Fix** - Generates code fixes for HIGH_PRIO warnings and optionally applies them
- **Diff Preview** - Review proposed fixes in VS Code's diff editor before applying
- **Inline Diagnostics** - Results appear in VS Code's Problems panel with squiggly underlines
- **Click-to-Navigate** - Click any log entry to jump to the warning location in your source code
- **Skip Analyzed** - Resume where you left off by skipping rows that already have a Priority value
- **Rule Selection** - Choose specific CERT-C rules to analyze (e.g., only EXP33-C warnings)
- **Export Report** - Generate an HTML summary report with pie chart and findings table
- **Project Config** - Settings auto-saved to `.certc-analyzer.json` for persistence across sessions
- **Parallel Processing** - Analyzes 3 warnings concurrently with ETA tracking

---

## Settings

All settings are available in the sidebar panel:

| Setting                  | Default   | Description                                      |
|--------------------------|-----------|--------------------------------------------------|
| Defensiveness            | Neutral   | How aggressively to classify warnings             |
| Auto-fix HIGH_PRIO       | Off       | Automatically apply code fixes for HIGH_PRIO      |
| Review fixes in diff     | On        | Show diff preview before applying each fix        |
| Skip already-analyzed    | On        | Skip rows that already have a Priority value      |
| Select CERT-C rules      | Off       | Pick which warning rules to analyze               |

Settings are automatically saved to `.certc-analyzer.json` in your workspace root when you start an analysis, and restored the next time you open the panel.

---

## How It Works

1. **Read** - Parses your Excel report to extract warning details
2. **Context** - Reads the source file and extracts the surrounding function, related definitions, and call chains
3. **Analyze** - Sends the warning + code context to GitHub Copilot with a structured 6-step analysis prompt
4. **Verify** - A second adversarial AI pass challenges every non-HIGH result to catch missed risks
5. **Write** - Results are written back to Excel immediately after each warning is processed

---

## Troubleshooting

**"GitHub Copilot extension is not installed"**
> Install GitHub Copilot from the Extensions panel (`Ctrl+Shift+X`), then sign in with your GitHub account.

**"No AI language model available"**
> Click the person icon in the bottom-left of VS Code and sign into GitHub. You need an active Copilot subscription.

**"Request was blocked by the content filter"**
> Some code patterns trigger Copilot's safety filter. The warning will be skipped automatically.

**Analysis is slow**
> The extension processes 3 warnings in parallel. Each warning requires two AI calls (analysis + verification). Expect ~5-10 seconds per warning depending on code complexity.

**Results not appearing in Excel**
> Close the Excel file in any other application before starting analysis. The extension writes results immediately after each warning is processed.

---

## License

[MIT](LICENSE)
