# Changelog

## [0.1.0] - 2025-03-08

### Added
- AI-powered analysis of CERT-C, MISRA C, and QAC static analysis warnings
- 2-pass adversarial verification for all non-critical results
- 3 priority levels: HIGH_PRIO, LOW_PRIO, FALSE_POSITIVE
- Defensiveness slider (Relaxed / Neutral / Strict)
- Auto-fix generation for HIGH_PRIO warnings
- Diff preview for reviewing fixes before applying
- Inline diagnostics in VS Code's Problems panel
- Click-to-navigate from log entries to source code
- Skip already-analyzed rows to resume interrupted sessions
- CERT-C rule selection via QuickPick
- HTML summary report export with pie chart
- Project config persistence via `.certc-analyzer.json`
- Parallel processing (3 concurrent workers) with ETA tracking
- Token usage estimation before analysis starts
