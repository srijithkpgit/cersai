import { AnalysisSummary } from './analyzerService';

interface ReportResult {
  rowNumber: number;
  priority: string;
  comment: string;
  filePath: string;
  lineInCode: number;
  fixApplied: boolean;
}

export function generateHtmlReport(
  summary: AnalysisSummary,
  results: ReportResult[],
  excelPath: string
): string {
  const highCount = summary.highPrio;
  const lowCount = summary.lowPrio;
  const fpCount = summary.falsePositive;
  const fixedCount = summary.fixed;
  const errorCount = summary.errors;
  const total = highCount + lowCount + fpCount;

  // SVG pie chart
  const pieChart = generatePieChart(highCount, lowCount, fpCount);

  // Results table rows
  const tableRows = results.map(r => {
    const badgeClass = r.priority === 'HIGH_PRIO' ? 'high'
      : r.priority === 'FALSE_POSITIVE' ? 'fp' : 'low';
    const badge = r.fixApplied ? 'FIXED' : r.priority.replace('_', ' ');
    const escapedComment = escapeHtml(r.comment).replace(/\n/g, '<br>');
    return `<tr>
      <td>${r.rowNumber}</td>
      <td><span class="badge ${badgeClass}">${badge}</span></td>
      <td class="file">${escapeHtml(r.filePath)}:${r.lineInCode}</td>
      <td class="comment">${escapedComment}</td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Cersai Analysis Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 24px; background: #1e1e1e; color: #d4d4d4; }
  h1 { font-size: 22px; margin-bottom: 4px; color: #fff; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 24px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .summary-card { background: #2d2d2d; border-radius: 8px; padding: 16px; text-align: center; }
  .summary-card .value { font-size: 28px; font-weight: 700; }
  .summary-card .label { font-size: 11px; color: #888; text-transform: uppercase; margin-top: 4px; }
  .summary-card.high .value { color: #f14c4c; }
  .summary-card.low .value { color: #73c991; }
  .summary-card.fp .value { color: #888; }
  .summary-card.fixed .value { color: #3794ff; }
  .chart-section { display: flex; align-items: center; gap: 32px; margin-bottom: 24px; background: #2d2d2d; border-radius: 8px; padding: 20px; }
  .legend { display: flex; flex-direction: column; gap: 8px; }
  .legend-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; }
  table { width: 100%; border-collapse: collapse; background: #2d2d2d; border-radius: 8px; overflow: hidden; }
  th { background: #333; text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; color: #888; }
  td { padding: 8px 12px; border-top: 1px solid #3a3a3a; font-size: 13px; vertical-align: top; }
  td.file { font-family: monospace; font-size: 12px; color: #9cdcfe; white-space: nowrap; }
  td.comment { max-width: 500px; word-break: break-word; font-size: 12px; line-height: 1.5; }
  .badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 3px; white-space: nowrap; }
  .badge.high { background: #f14c4c; color: #fff; }
  .badge.low { background: #73c991; color: #fff; }
  .badge.fp { background: #666; color: #fff; }
  h2 { font-size: 16px; margin-bottom: 12px; color: #fff; }
</style>
</head>
<body>
  <h1>Cersai Analysis Report</h1>
  <div class="subtitle">Source: ${escapeHtml(excelPath)} | Generated: ${new Date().toLocaleString()}</div>

  <div class="summary-grid">
    <div class="summary-card"><div class="value">${summary.total}</div><div class="label">Total Warnings</div></div>
    <div class="summary-card"><div class="value">${summary.analyzed}</div><div class="label">Analyzed</div></div>
    <div class="summary-card high"><div class="value">${highCount}</div><div class="label">High Priority</div></div>
    <div class="summary-card low"><div class="value">${lowCount}</div><div class="label">Low Priority</div></div>
    <div class="summary-card fp"><div class="value">${fpCount}</div><div class="label">False Positive</div></div>
    <div class="summary-card fixed"><div class="value">${fixedCount}</div><div class="label">Auto-Fixed</div></div>${summary.upgraded > 0 ? `
    <div class="summary-card" style="border-color:#cca700"><div class="value" style="color:#cca700">${summary.upgraded}</div><div class="label">Upgraded by Verify</div></div>` : ''}
  </div>

  <div class="chart-section">
    ${pieChart}
    <div class="legend">
      <div class="legend-item"><div class="legend-dot" style="background:#f14c4c"></div>HIGH_PRIO (${highCount})</div>
      <div class="legend-item"><div class="legend-dot" style="background:#73c991"></div>LOW_PRIO (${lowCount})</div>
      <div class="legend-item"><div class="legend-dot" style="background:#666"></div>FALSE_POSITIVE (${fpCount})</div>
    </div>
  </div>

  <h2>Findings</h2>
  <table>
    <thead><tr><th>Row</th><th>Priority</th><th>File</th><th>Comment</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;
}

function generatePieChart(high: number, low: number, fp: number): string {
  const total = high + low + fp;
  if (total === 0) {
    return '<svg width="160" height="160"><circle cx="80" cy="80" r="70" fill="#444"/><text x="80" y="85" text-anchor="middle" fill="#888" font-size="14">No data</text></svg>';
  }

  const slices = [
    { count: high, color: '#f14c4c' },
    { count: low, color: '#73c991' },
    { count: fp, color: '#666' },
  ].filter(s => s.count > 0);

  let paths = '';
  let startAngle = -Math.PI / 2;
  const cx = 80, cy = 80, r = 70;

  for (const slice of slices) {
    const angle = (slice.count / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const largeArc = angle > Math.PI ? 1 : 0;

    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);

    if (slices.length === 1) {
      paths += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${slice.color}"/>`;
    } else {
      paths += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc} 1 ${x2},${y2} Z" fill="${slice.color}"/>`;
    }
    startAngle = endAngle;
  }

  return `<svg width="160" height="160" viewBox="0 0 160 160">${paths}</svg>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
