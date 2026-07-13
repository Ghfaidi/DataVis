// Group 05 · Meriam Ferjani, Ghofrane Faidi

/*

This file builds Chart 4: the Correlation Heatmap.

What's a correlation heatmap? For every PAIR of columns you select, we
compute one number (from -1 to +1) saying how strongly they move together
(see pearsonCorr/spearmanCorr in stats.js), and draw it as a colored
square: deep blue/red for a strong relationship, pale for a weak one. Doing
this for every possible pair at once gives you a grid ("matrix") you can
scan for interesting relationships in seconds, instead of checking each
pair one at a time in a scatterplot.

Features in this file:
  - Choose which correlation method to use: Pearson (the "classic" one,
    best for straight-line relationships) or Spearman (based on RANK order,
    more forgiving of curved/non-linear relationships)
  - Choose which variables to include, grouped by category, with quick
    "select all"/"clear all"/"reset" buttons
  - A slider to make the cells bigger/smaller
  - Click any cell to instantly open that exact pair of variables in Chart 2's scatterplot
  - Cells with an "×" through them are NOT statistically significant
    (their correlation might just be random noise)
*/


// Grouped by variable role (mirrors the PCP picker colour scheme)
// Same 5 categories used in chart1-pcp.js's axis picker, reused here for the variable checkboxes and heatmap section labels
    const CORR_GROUPS = [
        { label: "Inputs",                    color: "#2563eb", cols: COLUMNS.inputs },
        { label: "Chemical Composition",      color: "#16a34a", cols: COLUMNS.chemistry },
        { label: "Microstructure",            color: "#0891b2", cols: MICROSTRUCTURE_AXES },
        { label: "Mechanical Properties",     color: "#be123c", cols: MECHANICAL_AXES },
        { label: "Thermophysical Properties", color: "#7c3aed", cols: THERMOPHYSICAL_AXES }
    ];
// Which variables are checked by default when the chart first loads
const DEFAULT_CORR_VARS = [
    ...COLUMNS.inputs,
    COLUMNS.ys, COLUMNS.csc, COLUMNS.hardness, COLUMNS.density, COLUMNS.thermCond,
    "delta_T", "T(sol)", "eut. frac.[%]"   // solidification variables — key correlates of CSC
];
let corrVars = DEFAULT_CORR_VARS.slice(); // the variables CURRENTLY selected (starts as a copy of the defaults)
let corrMethod = "pearson"; // "pearson" or "spearman"
let heatmapCellSize = 30;   // pixel size of each square cell, adjustable with the slider
const MIN_CORR_SAMPLE_SIZE = 5; // need at least this many rows for a correlation number to mean anything
const HEATMAP_TOP_PAD = 70; // extra space above the grid so rotated column labels don't get clipped
let heatmapReady = false;   // becomes true once the chart has been built for the first time
let lastClickedPair = null; // remembers the last cell you clicked, so it stays outlined in green
let _lastRCrit = 0;         // the "is this correlation statistically meaningful" threshold, recomputed each render


// createChart4(): builds the chart 4 UI from scratch - method buttons,
// cell-size slider, variable picker checkboxes, and the empty SVG the
// grid gets drawn into.

function createChart4() {
    chart4.selectAll("*").remove();
    lastClickedPair = null;

    // ---- Pearson / Spearman method toggle ----
    let methodBar = chart4.append("div").attr("class", "scatter-mode-bar");
    ["pearson", "spearman"].forEach(m => {
        methodBar.append("button")
            .attr("class", "mode-btn" + (corrMethod === m ? " active" : ""))
            .text(m === "pearson" ? "Pearson" : "Spearman")
            .on("click", () => { corrMethod = m; createChart4(); }); // rebuild so the active-button highlight updates too
    });

    // ---- cell-size slider ----
    let zoomControl = chart4.append("div").attr("class", "scatter-controls");
    zoomControl.append("label").text("Cell size: ");
    zoomControl.append("input")
        .attr("type", "range").attr("min", 14).attr("max", 50).attr("step", 2)
        .attr("value", heatmapCellSize)
        .attr("title", "Larger cells scroll horizontally if they don't fit; smaller cells fit more variables at once")
        .on("input", function () { heatmapCellSize = +this.value; renderChart4(); });

    chart4.append("div").attr("class", "chart-export-row")
        .append("button").attr("class", "export-btn")
        .text("↓ Export SVG")
        .on("click", () => {
            let svgEl = document.getElementById("heatmapSvg");
            if (svgEl) exportSvgEl(svgEl, "correlation-heatmap.svg");
        });



    // ---- variable picker: same checkbox-grid pattern as chart1-pcp.js ----
    let picker = chart4.append("div").attr("class", "pcp-axis-picker");
    
        // Axis role legend
    // A small legend row explaining what each axis label color means (matches the checkbox group colors)
    let roleLegend = chart4.append("div")
        .style("font-size", "11px").style("margin", "6px 0 2px")
        .style("display", "flex").style("gap", "14px")
        .style("flex-wrap", "wrap").style("align-items", "center");
    roleLegend.append("span").style("color", "#555").text("Axis colour key:");
    [
        ["#2563eb", "Input (controllable)"],
        ["#16a34a", "Chemical composition (derived)"],
        ["#0891b2", "Microstructure"],
        ["#be123c", "Mechanical property (target)"],
        ["#7c3aed", "Thermophysical property"]
    ].forEach(([color, txt]) => {
        let item = roleLegend.append("span").style("display", "inline-flex").style("align-items", "center").style("gap", "4px");
        item.append("span").style("display", "inline-block").style("width", "10px").style("height", "10px")
            .style("border-radius", "50%").style("background", color).style("flex-shrink", "0");
        item.append("span").style("color", color).style("font-weight", "600").text(txt);
    });

    // Controls row
    let pickerCtrl = picker.append("div").attr("class", "pcp-picker-controls");
    pickerCtrl.append("span").attr("class", "picker-label").text("Variables:");
    pickerCtrl.append("button").attr("class", "pcp-reset-btn").text("Select all")
        .on("click", () => { corrVars = CURATED_AXES.slice(); createChart4(); });
    pickerCtrl.append("button").attr("class", "pcp-reset-btn").text("Clear all")
        .on("click", () => { corrVars = []; createChart4(); });
    pickerCtrl.append("button").attr("class", "pcp-reset-btn").text("Reset to default")
        .on("click", () => { corrVars = DEFAULT_CORR_VARS.slice(); createChart4(); });



    CORR_GROUPS.forEach(group => {
        let groupDiv = picker.append("div").attr("class", "pcp-axis-group");
        groupDiv.append("span").attr("class", "pcp-group-label").style("color", group.color).text(group.label + ":");
        group.cols.forEach(col => {
            let lbl = groupDiv.append("label").attr("class", "axis-checkbox");
            lbl.append("input").attr("type", "checkbox")
                .attr("checked", corrVars.includes(col) ? true : null)
                .on("change", function () {
                    if (this.checked) { if (!corrVars.includes(col)) corrVars.push(col); }
                    else { corrVars = corrVars.filter(c => c !== col); }
                    renderChart4();
                });
            lbl.append("span").text(label(col));
        });
    });

    // Empty wrapper that will hold the actual heatmap <svg>, plus a hidden
    // "message" box used instead of the grid when there's nothing to show
    // (e.g. no variables picked, or too few rows selected)
    let wrapper = chart4.append("div").attr("class", "heatmap-wrapper");
    wrapper.append("svg").attr("id", "heatmapSvg");
    wrapper.append("div").attr("class", "chart-stub-note").attr("id", "heatmapMessage").style("display", "none");

    chart4.append("p").attr("class", "chart-hint").attr("id", "heatmapSampleLabel");
    chart4.append("p").attr("class", "chart-hint").text("Click a cell to open that pair in the Scatterplot (scrolls into view) · hover for exact value · × marks cells not significant at p < 0.05.");

    heatmapReady = true;
    renderChart4();
}

// Hides the heatmap grid and shows a plain text message instead (used when there's nothing valid to draw)
function showHeatmapMessage(msg) {
    d3.select("#heatmapSvg").selectAll("*").remove().attr("width", 0).attr("height", 0);
    d3.select("#heatmapMessage").style("display", "block").text(msg);
    d3.select("#heatmapSampleLabel").text("");
}


// Shows the shared tooltip box with the exact correlation value + whether it's statistically significant
function showHeatmapTooltip(event, rowVar, colVar, value, n) {
    let tooltip = d3.select(".tooltip");
    if (tooltip.empty()) tooltip = d3.select("body").append("div").attr("class", "tooltip").style("opacity", 0);
    let sig = Math.abs(value) >= _lastRCrit ? "p < 0.05" : "p ≥ 0.05 (not significant)";
    tooltip.transition().duration(100).style("opacity", 0.95);
    tooltip.html(
        `<b>${label(rowVar)}</b> vs <b>${label(colVar)}</b><br/>` +
        `${corrMethod === "pearson" ? "Pearson" : "Spearman"} r = ${value.toFixed(3)}<br/>` +
        `${sig}<br/>n = ${n.toLocaleString()}`
    )
        .style("left", (event.pageX + 12) + "px")
        .style("top", (event.pageY - 20) + "px");
}

// ------------------------------------------------------------------
// renderChart4(): (re)draws the whole heatmap grid - called whenever the
// method, variable list, cell size, or active filters change.
// ------------------------------------------------------------------
function renderChart4() {
    if (corrVars.length === 0) {
        showHeatmapMessage("Select at least one variable above to see correlations.");
        return;
    }

    let rows = activeRows(); // only alloys currently passing filters are used in the correlation math
    if (rows.length < MIN_CORR_SAMPLE_SIZE) {
        showHeatmapMessage(
            `Only ${rows.length} alloy${rows.length === 1 ? "" : "s"} in the current selection — ` +
            `too few for a meaningful correlation (need at least ${MIN_CORR_SAMPLE_SIZE}). ` +
            `Broaden the PCP brush or clear the cross-filter to see this chart.`
        );
        return;
    }
    d3.select("#heatmapMessage").style("display", "none");

    let isFiltered = rows.length !== alloyData.length;
    d3.select("#heatmapSampleLabel").text(
        `Computed over ${rows.length.toLocaleString()} alloy${rows.length === 1 ? "" : "s"}` +
        (isFiltered ? " (current PCP/cross-filter selection)." : " (full dataset).")
    );

    let svg = d3.select("#heatmapSvg");
    svg.selectAll("*").remove(); // full rebuild each time - simpler than trying to update an existing grid cell-by-cell

    let n = corrVars.length;
    let size = heatmapCellSize;
    let labelSpace = 160; // room reserved on the left/top for variable name labels
    svg.attr("width", labelSpace + n * size + 60)
        .attr("height", HEATMAP_TOP_PAD + labelSpace + n * size)
        .style("overflow", "visible");

    let corrRows = rows;

    // Pull out each selected column's values once, as plain arrays (faster
    // to work with in the math functions than looking them up on objects repeatedly)
    let colArrays = {};
    corrVars.forEach(c => { colArrays[c] = corrRows.map(d => d[c]); });

    // For Spearman, convert each column to RANKS once up front - this is
    // much faster than re-ranking inside pearsonCorr for every single
    // pair, since the same column's ranks get reused across many pairs
    let rankArrays = null;
    if (corrMethod === "spearman") {
        rankArrays = {};
        corrVars.forEach(c => { rankArrays[c] = rankArray(colArrays[c]); });
    }

    // Compute the full N x N correlation matrix, one number per pair of variables
    let matrix = [];
    for (let i = 0; i < n; i++) {
        matrix[i] = [];
        for (let j = 0; j < n; j++) {
            if (i === j) { matrix[i][j] = 1; continue; } // a variable always perfectly correlates with itself
            matrix[i][j] = corrMethod === "pearson"
                ? pearsonCorr(colArrays[corrVars[i]], colArrays[corrVars[j]])
                : pearsonCorr(rankArrays[corrVars[i]], rankArrays[corrVars[j]]); // = Spearman, using cached ranks
        }
    }

    //let order = corrVars.map((_, i) => i);
    //let orderedVars = order.map(oi => corrVars[oi]);
    //let orderedMatrix = order.map(oi => order.map(oj => matrix[oi][oj]));
    // Order variables by their dashboard group
    // Instead of showing variables in whatever order they were picked,
    // group them by category (Inputs, Chemical Composition, ...) so related
    // variables sit next to each other in the grid
    let orderedVars = [];

    CORR_GROUPS.forEach(group => {
        group.cols.forEach(col => {
            if (corrVars.includes(col)) {
                orderedVars.push(col);
            }
        });
    });

    // Add any variables not covered by groups
    corrVars.forEach(col => {
        if (!orderedVars.includes(col)) {
            orderedVars.push(col);
        }
    });

    let order = orderedVars.map(v => corrVars.indexOf(v));

    let orderedMatrix = order.map(oi =>
        order.map(oj => matrix[oi][oj])
    );

    // A correlation is considered "not statistically significant" (could
    // just be random noise) if its absolute value is below this threshold,
    // which depends on how many rows we have - more rows = a smaller
    // correlation can still be considered meaningful.
    let rCrit = 1.96 / Math.sqrt(Math.max(rows.length - 2, 1));
    _lastRCrit = rCrit;

    // Diverging color scale: deep red for -1, white for 0, deep blue for +1
    let color = d3.scaleDiverging(d3.interpolateRdBu).domain([1, 0, -1]);
    let g = svg.append("g").attr("transform", `translate(${labelSpace},${HEATMAP_TOP_PAD + labelSpace})`);
    // Draw group separators and labels
    // Work out where each category "block" starts/ends within the ordered variable list
    let groupPositions = [];
    let position = 0;

    CORR_GROUPS.forEach(group => {
        let count = group.cols.filter(c => orderedVars.includes(c)).length;

        if (count > 0) {
            groupPositions.push({
                label: group.label,
                start: position,
                end: position + count,
                color: group.color
            });

            position += count;
        }
    });

    // Draw a category label + a bold separator line around each category's block, on both axes
    groupPositions.forEach(group => {

        let start = group.start * size;
        let end = group.end * size;
        let center = (start + end) / 2;


        // Vertical separator
        g.append("line")
            .attr("x1", start)
            .attr("x2", start)
            .attr("y1", 0)
            .attr("y2", n * size)
            .attr("stroke", "#333")
            .attr("stroke-width", 2);


        // Horizontal separator
        g.append("line")
            .attr("x1", 0)
            .attr("x2", n * size)
            .attr("y1", start)
            .attr("y2", start)
            .attr("stroke", "#333")
            .attr("stroke-width", 2);
    });

    // final bottom/right borders
    g.append("rect")
        .attr("width", n * size)
        .attr("height", n * size)
        .attr("fill", "none")
        .attr("stroke", "#333")
        .attr("stroke-width", 2);
    // column headers (rotated) + row headers — colour-coded by variable role (mirrors PCP picker)
    orderedVars.forEach((c, j) => {
        svg.append("text")
            .attr("x", labelSpace + j * size + size / 2).attr("y", HEATMAP_TOP_PAD + labelSpace - 8)
            .attr("text-anchor", "start")
            .attr("transform", `rotate(-45,${labelSpace + j * size + size / 2},${HEATMAP_TOP_PAD + labelSpace - 8})`)
            .attr("class", "heatmap-label")
            .style("fill", _pcpAxisRoleColor(c))
            .text(label(c));
    });
    orderedVars.forEach((r, i) => {
        svg.append("text")
            .attr("x", labelSpace - 8).attr("y", HEATMAP_TOP_PAD + labelSpace + i * size + size / 2 + 4)
            .attr("text-anchor", "end").attr("class", "heatmap-label")
            .style("fill", _pcpAxisRoleColor(r))
            .text(label(r));
    });

    // ---- Draw every single cell in the grid ----
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            let isDiagonal = i === j; // a cell comparing a variable to itself
            let rowVar = orderedVars[i], colVar = orderedVars[j];
            let value = orderedMatrix[i][j];
            let isLastClicked = lastClickedPair && lastClickedPair.rowVar === rowVar && lastClickedPair.colVar === colVar;

            let cell = g.append("g").attr("transform", `translate(${j * size},${i * size})`);
            cell.append("rect")
                .attr("width", size).attr("height", size)
                .attr("fill", isDiagonal ? "#eee" : color(value))
                .attr("stroke", isLastClicked ? "#1b5e20" : "#fff")
                .attr("stroke-width", isLastClicked ? 2.5 : 1)
                .style("cursor", isDiagonal ? "default" : "pointer")
                // Clicking a cell jumps straight to that pair of variables in Chart 2's scatterplot
                .on("click", () => {
                    if (isDiagonal) return;
                    scatterAxes.x = colVar;
                    scatterAxes.y = rowVar;
                    createChart2();
                    lastClickedPair = { rowVar, colVar };
                    renderChart4();
                    // Smoothly scroll Chart 2 into view and briefly "flash" its border so it's obvious what changed
                    let c2card = chart2.node().parentElement;
                    c2card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    c2card.classList.add('chart-flash');
                    setTimeout(() => c2card.classList.remove('chart-flash'), 1600);
                })
                .on("mouseover", (event) => { if (!isDiagonal) showHeatmapTooltip(event, rowVar, colVar, value, rows.length); })
                .on("mouseout", hidePcpTooltip);
            // Print the actual correlation number inside the cell, if it's big enough to read
            if (size >= 24 && !isDiagonal) {
                cell.append("text")
                    .attr("x", size / 2).attr("y", size / 2 + 3)
                    .attr("text-anchor", "middle")
                    .attr("class", "heatmap-value")
                    .attr("fill", Math.abs(value) > 0.6 ? "#fff" : "#222") // white text on dark cells, dark text on light cells, so it's always readable
                    .text(value.toFixed(2));
            }
            // Draw a faint "×" over any cell that's NOT statistically significant
            if (!isDiagonal && Math.abs(value) < rCrit) {
                cell.append("line")
                    .attr("x1", 2).attr("y1", 2).attr("x2", size - 2).attr("y2", size - 2)
                    .attr("stroke", "rgba(0,0,0,0.35)").attr("stroke-width", 1).attr("pointer-events", "none");
                cell.append("line")
                    .attr("x1", size - 2).attr("y1", 2).attr("x2", 2).attr("y2", size - 2)
                    .attr("stroke", "rgba(0,0,0,0.35)").attr("stroke-width", 1).attr("pointer-events", "none");
            }
        }
    }
}
