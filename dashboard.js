// Group 05 · Meriam Ferjani, Ghofrane Faidi

/*

This file is the shared "brain" of the Part 2 Dashboard tab (the one with 5
charts). It doesn't draw any chart itself - instead it:

  1. Defines which data columns exist and what to call them nicely
     (e.g. the raw column "YS(MPa)" gets shown as "Yield Strength (MPa)")
  2. Holds the actual dataset in memory (alloyData) so every chart file can
     read the same data
  3. Runs the one-time heavy number-crunching when a file is loaded:
     cleaning missing values, computing the Pareto front, running PCA
  4. Keeps track of shared interactive state - which alloys are "pinned",
     which are cross-filter-highlighted, which one you're hovering - and
     tells every chart to redraw when that state changes
  5. Handles exporting charts/data and remembering your settings between visits

Basically: chart1-pcp.js, chart2-scatter.js, chart3-pca.js,
chart4-heatmap.js and chart5-dotplot.js all reach into this file's shared
variables and functions to get the data and to notify each other when
something changes.
*/


// COLUMNS: names of the important columns in the alloy dataset, grouped
// by what they mean. Using this object instead of typing the raw column
// name everywhere means if the CSV's column name ever changes, we only
// have to fix it here.

const COLUMNS = {
    inputs: ["KS1295[%]", "6082[%]", "2024[%]", "bat-box[%]", "3003[%]", "4032[%]"], // the scrap alloy percentages that go into an alloy
    chemistry: ["Al", "Si", "Cu", "Ni", "Mg", "Mn", "Fe", "Cr", "Ti", "Zr", "V", "Zn"], // resulting elemental makeup
    ys: "YS(MPa)",           // Yield Strength - how much force before it bends
    csc: "CSC",              // hot-Crack Susceptibility - a lower-is-better defect risk score
    hardness: "hardness(Vickers)",
    density: "Density(g/cm3)",
    thermCond: "Therm.conductivity(W/(mK))"
};

// Columns related to how the alloy solidifies/freezes when cooling
const SOLIDIFICATION_AXES = [
    "T(liqu)", "T(sol)", "delta_T",
    "delta_T_FCC", "delta_T_Al15Si2M4", "delta_T_Si",
    "eut. frac.[%]", "eut. T (°C)"
];

// A grab-bag of other computed physical properties available for plotting
const EXTRA_OUTPUT_AXES = [
    "CTEvol(1/K)(20.0-300.0°C)",
    "Volume(m3/mol)",
    "El.conductivity(S/m)",
    "El. resistivity(ohm m)",
    "heat capacity(J/(mol K))",
    "Therm. diffusivity(m2/s)",
    "Therm.resistivity(mK/W)",
    "Linear thermal expansion (1/K)(20.0-300.0°C)",
    "Technical thermal expansion (1/K)(20.0-300.0°C)"
];

// These 3 groups split the columns above ( except input and chemistry) by physical meaning - used
// everywhere the dashboard groups variables into categories (the PCP axis
// picker, the correlation heatmap picker, the scatterplot dropdowns, and
// the diverging dot plot's sections).
const MECHANICAL_AXES = [COLUMNS.ys, COLUMNS.csc, COLUMNS.hardness]; // strength/hardness - how the alloy behaves under force
const MICROSTRUCTURE_AXES = [ ...SOLIDIFICATION_AXES]; // cracking risk + how the alloy solidifies/freezes
const THERMOPHYSICAL_AXES = [COLUMNS.density, COLUMNS.thermCond, ...EXTRA_OUTPUT_AXES]; // density, heat/electrical behavior

// Every axis/column we allow the user to pick from anywhere in the dashboard
const CURATED_AXES = [
    ...COLUMNS.inputs,
    ...COLUMNS.chemistry,
    ...MICROSTRUCTURE_AXES,
    ...MECHANICAL_AXES,
    ...THERMOPHYSICAL_AXES
];

// Which axes show up pre-checked the first time you open the Parallel Coordinates Plot
const DEFAULT_PCP_AXES = [...COLUMNS.inputs, COLUMNS.ys, COLUMNS.csc, COLUMNS.hardness, COLUMNS.thermCond, "delta_T"];

// LABELS: a lookup table that turns a raw, cryptic column name (as it
// appears in the CSV file) into a friendly, readable name to show on charts.
const LABELS = {
    "KS1295[%]": "KS1295 (%)",
    "6082[%]": "6082 (%)",
    "2024[%]": "2024 (%)",
    "bat-box[%]": "Bat-Box (%)",
    "3003[%]": "3003 (%)",
    "4032[%]": "4032 (%)",
    "YS(MPa)": "Yield Strength (MPa)",
    "CSC": "Hot-Crack Susceptibility",
    "hardness(Vickers)": "Hardness (Vickers)",
    "Density(g/cm3)": "Density (g/cm³)",
    "Therm.conductivity(W/(mK))": "Thermal Conductivity (W/mK)",
    "T(liqu)":           "Liquidus Temp. (°C)",
    "T(sol)":            "Solidus Temp. (°C)",
    "delta_T":           "Freezing Range ΔT (°C)",
    "delta_T_FCC":       "FCC Freezing Range (°C)",
    "delta_T_Al15Si2M4": "Al₁₅Si₂M₄ Freezing Range (°C)",
    "delta_T_Si":        "Si Freezing Range (°C)",
    "eut. frac.[%]":     "Eutectic Fraction (%)",
    "eut. T (°C)":       "Eutectic Temp. (°C)",
    "CTEvol(1/K)(20.0-300.0°C)":                     "Volumetric CTE (1/K)",
    "Volume(m3/mol)":                                  "Molar Volume (m³/mol)",
    "El.conductivity(S/m)":                            "Electrical Conductivity (S/m)",
    "El. resistivity(ohm m)":                          "Electrical Resistivity (Ω·m)",
    "heat capacity(J/(mol K))":                        "Heat Capacity (J/mol·K)",
    "Therm. diffusivity(m2/s)":                        "Thermal Diffusivity (m²/s)",
    "Therm.resistivity(mK/W)":                         "Thermal Resistivity (mK/W)",
    "Linear thermal expansion (1/K)(20.0-300.0°C)":    "Linear CTE (1/K)",
    "Technical thermal expansion (1/K)(20.0-300.0°C)": "Technical CTE (1/K)"
};
// Look up the friendly name for a column; if we don't have one, just show the raw name as-is
function label(col) { return LABELS[col] || col; }

// Shared colors: amber for "Pareto-optimal" alloys, blue for "pinned" alloys - used across all 5 charts
const COLOR_PARETO = "#e8a33d";
const COLOR_PINNED = "#1d4ed8";

// SHARED STATE: these variables hold the "current situation" of the whole
// dashboard. Every chart file reads and/or updates these.

let alloyData = [];                 // the full uploaded dataset, one object per alloy row
let pcaVarianceExplained = [0, 0];  // how much of the data's spread PC1/PC2 capture (see stats.js computePCA2D)
let paretoIndexSet = new Set();     // which row indexes are on the main Pareto front
let pinnedIds = [];                 // ids of alloys the user has "pinned" for comparison (max 3)
const MAX_PINNED = 3;
const PCP_BACKGROUND_SAMPLE_SIZE = 3000; // for huge datasets, only draw this many faint background lines in Chart 1 (for speed) - counts/filters still use ALL rows
let pcpBackgroundSample = [];
let pcaLoadings = { pc1: [], pc2: [] }; // which columns drive PC1/PC2 the most
let allPcaScopes = {};               // pre-computed PCA results for different subsets of columns (chart3 lets you switch between them)
let imputationReport = { phaseFractionImputed: 0, generalImputed: 0, excludedCols: 0 }; // how many missing cells we had to fill in
let filterVersion = 0;               // bumped every time any filter changes - lets other code know "something changed, recompute your cache"

// A tiny homemade random-number generator that always produces the SAME
// sequence for the same "seed" number. Using our own instead of
// Math.random() means the background sample in Chart 1 stays IDENTICAL
// between redraws (e.g. after a resize) instead of jumping around randomly.
function _seededRand(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

// Picks `n` random items out of `arr`, using the seeded random generator
// above so the result is reproducible. Used to pick which alloys draw as
// faint background lines in the Parallel Coordinates Plot when there are
// too many to draw all of them smoothly.
function sampleArray(arr, n, seed = 42) {
    if (arr.length <= n) return arr.slice(); // nothing to sample, just return everything
    let rand = _seededRand(seed);
    let copy = arr.slice();
    // Shuffle-and-pick: swap random items to the front, one at a time, then take the first n
    for (let i = 0; i < n; i++) {
        let j = i + Math.floor(rand() * (copy.length - i));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
}


// Lets any chart look up a specific alloy row instantly by its id string
// (like "Alloy #42") instead of having to search through the whole array.
let alloyById = new Map();


// ------------------------------------------------------------------
// getExtent(): the min/max of a column, cached so we don't recompute it
// over and over every time a chart redraws (that would be slow on large
// datasets, since it has to scan every single row).
// ------------------------------------------------------------------
let extentCache = {};
function resetExtentCache() { extentCache = {}; }
function getExtent(col) {
    if (!extentCache[col]) extentCache[col] = d3.extent(alloyData, d => d[col]);
    return extentCache[col];
}

// The weighted "quality score" (see stats.js computeWeightedScore /
// chart3-pca.js) changes whenever the user moves a slider, so its cached
// min/max needs to be thrown away and recalculated then.
function invalidateScoreExtent() { delete extentCache["__score"]; }


// ------------------------------------------------------------------
// CROSS-FILTERING: when you draw a lasso or a target box in one chart
// (like the Scatterplot or PCA map), the matching alloys get remembered
// here, and every other chart dims down anything NOT in that set. This is
// what makes the dashboard feel "linked" instead of like 5 separate charts.
// ------------------------------------------------------------------
let externalHighlightIds = null;

function setExternalHighlight(rows, sourceLabel) {
    externalHighlightIds = new Set(rows.map(d => d.__id));
    filterVersion++;
    refreshAllCharts();
    updateStatusBar(sourceLabel);
}
function clearExternalHighlight() {
    externalHighlightIds = null;
    filterVersion++;
    refreshAllCharts();
    updateStatusBar();
}

// ------------------------------------------------------------------
// HOVERING: when you hover an alloy's dot/line in one chart, we remember
// its id here, so the other charts can also draw a little highlight ring
// on that same alloy - it's the visual equivalent of the cross-filtering
// above but for a single item, temporarily, on mouse-over.
// ------------------------------------------------------------------
let hoveredId = null;
function setHovered(id) {
    if (hoveredId === id) return; // no change, skip redundant redraws
    hoveredId = id;
    // Each of these functions is defined in its own chart file; the
    // "typeof ... === function" check just guards against calling one
    // before its file has finished loading/running.
    if (typeof renderPcpHoverLine === "function") renderPcpHoverLine();
    if (typeof renderScatterHoverDot === "function") renderScatterHoverDot();
    if (typeof renderPcaHoverDot === "function") renderPcaHoverDot();
}
function clearHovered() {
    if (!hoveredId) return;
    hoveredId = null;
    if (typeof renderPcpHoverLine === "function") renderPcpHoverLine();
    if (typeof renderScatterHoverDot === "function") renderScatterHoverDot();
    if (typeof renderPcaHoverDot === "function") renderPcaHoverDot();
}

// Tells every chart that's currently ready to redraw itself. Called
// whenever something shared changes (a filter, a pin, restoring saved
// settings, etc.) so the whole dashboard stays in sync.
function refreshAllCharts() {
    if (pcpCtx) renderChart1(currentPcpAxes, currentPcpFilters);
    if (scatterCtx) renderChart2();
    if (pcaCtx) renderChart3();
    if (heatmapReady) renderChart4();
    if (chart5Ready) renderChart5();
}

// The 5 outer <div> containers, one per chart, grabbed once the data is ready
let chart1, chart2, chart3, chart4, chart5;

// ------------------------------------------------------------------
// initDashboard(): the "start button" for the whole Dashboard tab. Called
// once after a file is uploaded (see dataVis.js). It cleans the data,
// grabs the 5 chart container boxes, and tells each chart file to build
// itself for the first time.
// ------------------------------------------------------------------
function initDashboard(_data) {
    if (!_data || _data.length === 0) return;

    preprocessData(_data); // clean missing values + compute Pareto front + PCA (see below)

    chart1 = d3.select("#chart1");
    chart2 = d3.select("#chart2");
    chart3 = d3.select("#chart3");
    chart4 = d3.select("#chart4");
    chart5 = d3.select("#chart5");

    // Each of these functions lives in its matching chartN-*.js file
    createChart1();
    createChart2();
    createChart3();
    createChart4();
    createChart5();

    updateStatusBar();
    restoreState(); // re-apply whatever settings were saved from a previous visit (see bottom of this file)

    // If the browser window gets resized, wait until the user stops
    // resizing (280ms of no more resize events) before rebuilding the
    // charts - rebuilding on every tiny pixel change would be wasteful and
    // laggy, so we "debounce" it.
    let _resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => {
            if (alloyData.length === 0) return;
            createChart1(false);
            createChart2();
            createChart3();
            renderChart4();
            renderChart5();
        }, 280);
    });
}

// Wipes all 5 chart containers empty (not currently called anywhere but kept as a utility)
function clearDashboard() {
    [chart1, chart2, chart3, chart4, chart5].forEach(c => c && c.selectAll("*").remove());
}


// Splits the raw uploaded column names into 3 buckets, based on a naming
// convention in the source data:
//  - "Vf_..." columns = phase fraction columns (how much of a phase is present)
//  - "T_..."  columns = phase formation temperature (only meaningful if that phase exists)
//  - everything else  = "general" columns
function classifyColumns(cols) {
    let phaseFractionCols = cols.filter(c => c.startsWith("Vf_"));
    let phaseTempCols = cols.filter(c => c.startsWith("T_"));
    let generalCols = cols.filter(c => !phaseFractionCols.includes(c) && !phaseTempCols.includes(c));
    return { phaseFractionCols, phaseTempCols, generalCols };
}

// ------------------------------------------------------------------
// preprocessData(): this is where all the "one-time, heavy" work happens
// right after a file is loaded - before any chart gets drawn. It:
//   1. Fills in any missing values (imputation)
//   2. Gives every row a unique id ("Alloy #0", "Alloy #1", ...)
//   3. Computes the main Pareto front (Yield Strength vs. Cracking)
//   4. Runs PCA three different ways (all columns / just properties / just recipe inputs)
//   5. Picks a random background sample for the PCP chart (for speed on big files)
// ------------------------------------------------------------------
function preprocessData(rawData) {
    resetExtentCache();
    filterVersion++;
    externalHighlightIds = null;
    alloyById.clear();

    let { phaseFractionCols, phaseTempCols, generalCols } = classifyColumns(rawData.columns);

    // Missing phase-fraction cells really mean "0% of this phase" -> fill with 0.
    // Missing "general" cells get filled with that column's average instead.
    let { imputedCount: fractionsImputed } = imputeConstant(rawData, phaseFractionCols, 0);
    let { imputedCount: generalImputed } = imputeMean(rawData, generalCols);
    imputationReport = { phaseFractionImputed: fractionsImputed, generalImputed: generalImputed, excludedCols: phaseTempCols.length };
    console.log(
        `Preprocessing: ${fractionsImputed} phase-fraction cells imputed to 0 (phase absent), ` +
        `${generalImputed} general cells mean-imputed. ${phaseTempCols.length} phase-formation-temperature ` +
        `columns excluded from PCA/correlation (undefined when the phase never forms).`
    );


    // The columns we'll actually feed into PCA/correlation - phase-formation
    // temperatures are left out since they're meaningless when a phase never forms
    let numericCols = [...generalCols, ...phaseFractionCols];

    // Give every row a stable, human-readable id, and index it for fast lookup
    rawData.forEach((row, i) => {
        row.__id = "Alloy #" + i;
        alloyById.set(row.__id, row);
    });

    // Compute the main Pareto front: alloys where you can't get higher
    // Yield Strength AND lower Cracking at the same time from any other alloy
    paretoIndexSet = paretoFront2D(rawData, COLUMNS.ys, "max", COLUMNS.csc, "min");
    rawData.forEach((row, i) => { row.__pareto = paretoIndexSet.has(i); });
    console.log(`Pareto front: ${paretoIndexSet.size} of ${rawData.length} alloys are non-dominated (YS max / CSC min).`);

    // Run PCA over ALL numeric columns - this is the "everything included" view
    let pcaResult = computePCA2D(rawData, numericCols);
    rawData.forEach((row, i) => {
        row.__pc1 = pcaResult.points[i].pc1;
        row.__pc2 = pcaResult.points[i].pc2;
    });
    pcaLoadings = pcaResult.loadings;
    console.log(`PCA: PC1/PC2 explain ${(pcaResult.varianceExplained[0] * 100).toFixed(1)}% / ${(pcaResult.varianceExplained[1] * 100).toFixed(1)}% of variance.`);
    pcaVarianceExplained = pcaResult.varianceExplained;

    // allPcaScopes holds a few different "flavors" of PCA, so Chart 3 can
    // let the user switch between them (e.g. "just the recipe inputs" vs
    // "all the resulting properties") without recomputing on the fly.
    allPcaScopes = {};
    allPcaScopes.all = {
        ve: pcaResult.varianceExplained,
        loadings: pcaResult.loadings,
        pc1: "__pc1", pc2: "__pc2",
        label: "All variables (phase fractions dominate)"
    };

    // "Property space" PCA: chemistry + the main output properties only
    let propPcaCols = [
        ...COLUMNS.chemistry,
        COLUMNS.ys, COLUMNS.csc, COLUMNS.hardness, COLUMNS.density, COLUMNS.thermCond,
        "delta_T", "T(sol)", "T(liqu)", "eut. frac.[%]"
    ].filter(c => numericCols.includes(c));

    if (propPcaCols.length >= 2) {
        let pcaProps = computePCA2D(rawData, propPcaCols);
        rawData.forEach((row, i) => {
            row.__pc1_props = pcaProps.points[i].pc1;
            row.__pc2_props = pcaProps.points[i].pc2;
        });
        allPcaScopes.props = {
            ve: pcaProps.varianceExplained,
            loadings: pcaProps.loadings,
            pc1: "__pc1_props", pc2: "__pc2_props",
            label: "Property space (chemistry + microstructure + properties)"
        };
        console.log(`PCA (property space): PC1/PC2 explain ${(pcaProps.varianceExplained[0]*100).toFixed(1)}% / ${(pcaProps.varianceExplained[1]*100).toFixed(1)}% over ${propPcaCols.length} columns.`);
    }

    // "Input space" PCA: just the 6 raw recipe percentages
    let inputPcaCols = COLUMNS.inputs.filter(c => numericCols.includes(c));
    if (inputPcaCols.length >= 2) {
        let pcaInputs = computePCA2D(rawData, inputPcaCols);
        rawData.forEach((row, i) => {
            row.__pc1_inputs = pcaInputs.points[i].pc1;
            row.__pc2_inputs = pcaInputs.points[i].pc2;
        });
        allPcaScopes.inputs = {
            ve: pcaInputs.varianceExplained,
            loadings: pcaInputs.loadings,
            pc1: "__pc1_inputs", pc2: "__pc2_inputs",
            label: "Input space (mixing ratios only)"
        };
        console.log(`PCA (input space): PC1/PC2 explain ${(pcaInputs.varianceExplained[0]*100).toFixed(1)}% / ${(pcaInputs.varianceExplained[1]*100).toFixed(1)}% over ${inputPcaCols.length} columns.`);
    }

    alloyData = rawData;
    // For very large files, drawing every single row as a PCP background
    // line would be slow, so we just draw a random sample of up to 3000 -
    // filters/counts elsewhere still use the FULL dataset, only the faint
    // background lines are sampled.
    pcpBackgroundSample = sampleArray(alloyData, PCP_BACKGROUND_SAMPLE_SIZE);
    console.log(`PCP: sampling ${pcpBackgroundSample.length.toLocaleString()} of ${alloyData.length.toLocaleString()} alloys for the background lines (all filters/counts still use the full dataset).`);
}

// ------------------------------------------------------------------
// updateStatusBar(): rebuilds the small text strip near the top of the
// dashboard, showing how many alloys are loaded, how many are on the
// Pareto front, which ones are pinned, and whether a cross-filter is active.
// ------------------------------------------------------------------
function updateStatusBar(highlightSourceLabel) {
    let el = d3.select("#dashboardStatus");
    if (el.empty()) return;

    let crossFilterHtml = "";
    if (externalHighlightIds) {
        let src = highlightSourceLabel || "another chart";
        crossFilterHtml =
            ` &middot; <span class="crossfilter-note">cross-filtered from ${src} ` +
            `(<a href="#" id="clearCrossFilterLink">clear</a>)</span>`;
    }

    let pinnedHtml = "";
    if (pinnedIds.length > 0) {
        let tags = pinnedIds.map(id =>
            `<span class="pinned-tag">${id}&nbsp;<a href="#" class="unpin-link" data-id="${id}" title="Unpin ${id}">&times;</a></span>`
        ).join(" ");
        pinnedHtml = ` &middot; <span class="picker-label" style="font-weight:600">Pinned:</span> ${tags}`;
    } else {
        pinnedHtml = ` &middot; <span style="color:#999">No alloys pinned</span>`;
    }

    el.html(
        `<b>${alloyData.length.toLocaleString()}</b> alloys loaded &middot; ` +
        `<b>${paretoIndexSet.size.toLocaleString()}</b> Pareto-optimal (YS&uarr; / CSC&darr;)` +
        pinnedHtml +
        crossFilterHtml
    );

    // Wire up the little "×" unpin links and "clear" cross-filter link we
    // just wrote into the HTML above (has to be done AFTER el.html(...)
    // replaces the content, since the old links no longer exist in the page)
    d3.selectAll(".unpin-link").on("click", function (event) {
        event.preventDefault();
        togglePin(this.getAttribute("data-id"));
    });

    if (externalHighlightIds) {
        d3.select("#clearCrossFilterLink").on("click", (event) => {
            event.preventDefault();
            clearExternalHighlight();
        });
    }
}


// ------------------------------------------------------------------
// togglePin(): add/remove an alloy from the "pinned" list (used to
// permanently compare a few chosen alloys across charts, unlike hovering
// which is temporary). If already at MAX_PINNED, the oldest pin gets
// bumped off to make room for the new one.
// ------------------------------------------------------------------
function togglePin(id) {
    let i = pinnedIds.indexOf(id);
    if (i >= 0) {
        pinnedIds.splice(i, 1); // already pinned -> unpin it
    } else {
        if (pinnedIds.length >= MAX_PINNED) pinnedIds.shift(); // drop the oldest pin
        pinnedIds.push(id);
    }
    updateStatusBar();
    // Tell every chart that cares about pins to redraw
    if (pcpCtx) renderChart1(currentPcpAxes, currentPcpFilters);
    if (scatterCtx) renderChart2();
    if (pcaCtx) renderChart3();
    renderChart5();
}

// ------------------------------------------------------------------
// EXPORTING: these functions let the user download a chart as an image
// file, or the filtered data as a spreadsheet-friendly CSV file.
// ------------------------------------------------------------------

// Some charts are drawn using BOTH a <canvas> (for speed, lots of points)
// AND an <svg> layered on top (for crisp lines/text/interactivity). To
// export a single flat PNG image, we have to draw both layers onto one
// temporary canvas and then save THAT as an image.
function exportLayeredChart(svgNode, canvasNode, filename) {
    let svgData = new XMLSerializer().serializeToString(svgNode); // turn the SVG into a text string
    let svgUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
    let img = new Image();
    img.onload = function () {
        // Build a fresh canvas the same size as the original, painted white first (SVGs are transparent by default)
        let ec = document.createElement('canvas');
        ec.width = canvasNode.width; ec.height = canvasNode.height;
        let ctx = ec.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, ec.width, ec.height);
        ctx.drawImage(canvasNode, 0, 0); // paint the canvas layer (e.g. the scattered dots)
        ctx.drawImage(img, 0, 0);        // paint the SVG layer on top (e.g. axes/lines)
        // Trigger a download of the combined image
        let a = document.createElement('a');
        a.download = filename; a.href = ec.toDataURL('image/png'); a.click();
    };
    img.src = svgUrl;
}

// Simpler export for charts that are pure SVG (no canvas layer) - just
// saves the SVG markup directly as a .svg file
function exportSvgEl(svgNode, filename) {
    let svgData = new XMLSerializer().serializeToString(svgNode);
    let blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    let a = document.createElement('a');
    a.download = filename; a.href = URL.createObjectURL(blob); a.click();
}

// Downloads whatever alloys currently pass the active filters as a CSV
// file, with 2 extra computed columns added on: whether it's Pareto-optimal,
// and its weighted score (if one has been computed).
function exportFilteredCsv() {
    if (!alloyData.length) return;
    let rows = activeRows(); // defined in chart1-pcp.js - the alloys currently passing all filters
    let baseCols = alloyData.columns ? alloyData.columns.filter(c => !c.startsWith('__')) :
        Object.keys(rows[0]).filter(c => !c.startsWith('__'));
    let cols = [...baseCols, 'pareto_optimal', 'weighted_score'];
    let header = cols.join(',');
    let body = rows.map(r => cols.map(c => {
        if (c === 'pareto_optimal') return r.__pareto ? 'true' : 'false';
        if (c === 'weighted_score') return r.__score !== undefined ? r.__score.toFixed(4) : '';
        let v = r[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string' && v.includes(',')) return '"' + v + '"'; // quote any text that itself contains a comma
        return v;
    }).join(',')).join('\n');
    let blob = new Blob([header + '\n' + body], { type: 'text/csv' });
    let a = document.createElement('a');
    a.download = 'alloys-filtered.csv'; a.href = URL.createObjectURL(blob); a.click();
}

// ------------------------------------------------------------------
// SAVE / RESTORE: remembers your dashboard settings (pinned alloys, chosen
// axes, correlation method, PCA weights) in the browser's own storage
// (localStorage), so if you close and reopen the page, your setup comes
// back automatically instead of resetting.
// ------------------------------------------------------------------
function saveState() {
    try {
        localStorage.setItem('dvDashboardState', JSON.stringify({
            pinnedIds,
            pcpAxes: typeof currentPcpAxes !== 'undefined' ? currentPcpAxes : null,
            scatterAxes: typeof scatterAxes !== 'undefined' ? scatterAxes : null,
            corrMethod: typeof corrMethod !== 'undefined' ? corrMethod : null,
            pcaWeights: typeof pcaWeights !== 'undefined' ? { ...pcaWeights } : null,
        }));
    } catch (e) { /* localStorage can fail (e.g. private browsing) - just skip saving silently */ }
}

function loadSavedState() {
    try {
        return JSON.parse(localStorage.getItem('dvDashboardState') || '{}');
    } catch (e) { return {}; }
}

// Applies whatever was saved last time, but only using values that are
// still valid for the CURRENTLY loaded dataset (e.g. a pinned alloy id
// that no longer exists just gets quietly dropped instead of breaking things).
function restoreState() {
    let s = loadSavedState();
    if (!s || !Object.keys(s).length) return;
    if (s.pinnedIds && Array.isArray(s.pinnedIds)) {
        pinnedIds = s.pinnedIds.filter(id => alloyById.has(id));
    }
    if (s.pcpAxes && Array.isArray(s.pcpAxes) && typeof currentPcpAxes !== 'undefined') {
        let validAxes = s.pcpAxes.filter(c => CURATED_AXES.includes(c));
        if (validAxes.length >= PCP_MIN_AXIS_COUNT) currentPcpAxes = validAxes;
    }
    if (s.scatterAxes && typeof scatterAxes !== 'undefined') {
        if (CURATED_AXES.includes(s.scatterAxes.x)) scatterAxes.x = s.scatterAxes.x;
        if (CURATED_AXES.includes(s.scatterAxes.y)) scatterAxes.y = s.scatterAxes.y;
    }
    if (s.corrMethod && typeof corrMethod !== 'undefined' && ['pearson', 'spearman'].includes(s.corrMethod)) {
        corrMethod = s.corrMethod;
    }
    if (s.pcaWeights && typeof pcaWeights !== 'undefined') {
        Object.keys(pcaWeights).forEach(k => {
            if (s.pcaWeights[k] !== undefined) pcaWeights[k] = +s.pcaWeights[k];
        });
    }
    refreshAllCharts();
    updateStatusBar();
}
