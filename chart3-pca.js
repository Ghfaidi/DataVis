// Group 05 · Meriam Ferjani, Ghofrane Faidi

/*

This file builds Chart 3: the PCA Embedding Map.

Quick reminder of what PCA does (full explanation is in stats.js): it takes
data with MANY columns and squashes it down to just 2 numbers per alloy
("PC1" and "PC2") that we can plot like a normal x/y scatterplot, while
keeping alloys that are "similar overall" close together and alloys that
are "different overall" far apart. So in this chart:
  - POSITION (where a dot sits) = how similar/different that alloy is from
    others, structurally
  - COLOR of a dot = a separate thing: a "weighted quality score" that YOU
    control with the sliders (e.g. "I care about Yield Strength a lot,
    Density a little") - this has nothing to do with the PCA math itself,
    it's just an independent way to color the same dots.

Features in this file:
  - A toggle between 2 different PCA "scopes" (which columns went into the
    PCA math) - see allPcaScopes in dashboard.js
  - Sliders to set how much each property should count towards the color score
  - A "loadings" panel showing which original columns drive PC1/PC2 the most
  - Lasso selection to cross-filter the other charts
  - Hover/click just like the other charts, using the shared tooltip
*/

// The default slider weights: how much each property counts towards the
// "quality score" that colors the dots. These don't need to add up to
// anything special - they get normalized (divided by their total) before use.
let pcaWeights = {
    [COLUMNS.ys]: 0.4,
    [COLUMNS.csc]: 0.3,
    [COLUMNS.hardness]: 0.1,
    [COLUMNS.density]: 0.1,
    [COLUMNS.thermCond]: 0.1
};
let pcaWidth = 420, pcaHeight = 420;
let pcaMargin = { top: 20, right: 20, bottom: 40, left: 50 };
let pcaCanvas, pcaCtx, pcaSvg;
let pcaLassoPoints = [], pcaLassoPath;
let pcaMode = "none"; // "none" (hover/click) or "lasso"
let pcaScope = "props"; // which PCA "flavor" is currently shown: "props" or "inputs" (see allPcaScopes)
const PCA_HOVER_RADIUS = 8;
let weightValueLabels = {}; // remembers the little text elements next to each slider, so we can update their numbers without rebuilding everything
let lastPcaMatches = [];
let lastScoreWeightsKey = null; // used to skip recomputing the score if the weights haven't actually changed


// computeDirectedWeightedScore(): works out one "quality score" per alloy
// based on the slider weights. Similar to computeWeightedScore in
// stats.js, but this version also takes into account whether higher or
// lower is "better" for each property (so e.g. a low CSC/cracking value
// correctly counts as a GOOD score, not a bad one).

function computeDirectedWeightedScore(data, weights) {
    let cols = Object.keys(weights);
    // Skip the (somewhat expensive) recomputation entirely if the weights are identical to last time
    let key = cols.map(c => c + ":" + weights[c]).join("|");
    if (key === lastScoreWeightsKey) return;
    lastScoreWeightsKey = key;

    let wSum = cols.reduce((s, c) => s + weights[c], 0) || 1;
    data.forEach(d => {
        let score = 0;
        cols.forEach(c => {
            let [lo, hi] = getExtent(c);
            let norm = hi > lo ? (d[c] - lo) / (hi - lo) : 0; // rescale to 0-1 first
            if (directionOf(c) === "min") norm = 1 - norm; // flip it if lower is actually better for this column
            score += (weights[c] / wSum) * norm;
        });
        d.__score = score;
    });
    invalidateScoreExtent(); // the score's min/max changed, so throw away any cached version of it
}

// Returns whichever PCA "scope" (all variables / property space / input
// space) is currently selected, falling back to a sensible default if
// something's missing
function pcaCurrentScope() {
    return (allPcaScopes && allPcaScopes[pcaScope]) || allPcaScopes.all || {
        ve: pcaVarianceExplained, loadings: pcaLoadings, pc1: "__pc1", pc2: "__pc2", label: "All variables"
    };
}


// createChart3(): builds the chart 3 UI from scratch - the scope buttons,
// weight sliders, loadings panel, mode buttons, and the canvas/svg drawing area.

function createChart3() {
    chart3.selectAll("*").remove();
    lastScoreWeightsKey = null;
    weightValueLabels = {};

    let _cw = chart3.node() ? chart3.node().clientWidth - 4 : 420;
    pcaWidth = Math.max(300, Math.min(720, _cw));
    pcaHeight = pcaWidth;
    pcaMargin = { top: 20, right: 20, bottom: 40, left: pcaWidth < 380 ? 40 : 50 };

    // ---- "PCA space" toggle: switch between the 2 pre-computed PCA scopes ----
    let scopeBar = chart3.append("div").attr("class", "scatter-mode-bar").style("margin-bottom", "6px");
    scopeBar.append("span").attr("class", "picker-label").text("PCA space: ");
    [
        ["props", "Property space", "PCA on chemistry + microstructure + properties: position reflects property similarity (recommended)"],
        ["inputs", "Input space", "PCA on the 6 mixing ratio inputs: position reflects design-space coverage"]
    ].forEach(([s, lbl, title]) => {
        scopeBar.append("button")
            .attr("class", "mode-btn" + (pcaScope === s ? " active" : ""))
            .text(lbl)
            .attr("title", title)
            .on("click", () => {
                if (!allPcaScopes[s]) return; // that scope wasn't computed (e.g. not enough columns available)
                pcaScope = s;
                createChart3();
            });
    });

    chart3.append("p").attr("class", "chart-hint")
        .html("<b>Position</b> = structural similarity in variable space &nbsp;|&nbsp; <b>Color</b> = weighted quality score (independent calculation).");

    //let varianceLabel = chart3.append("p").attr("class", "chart-hint").attr("id", "pcaVarianceLabel");
    let varianceLabel = chart3.append("p").attr("class", "chart-hint").attr("id", "pcaVarianceLabel")
    .style("margin-bottom", "16px");
    // ---- Weight sliders: one per property, lets the user decide how much each counts towards the color score ----
    let sliderPanel = chart3.append("div").attr("class", "pca-weight-panel");
    sliderPanel.append("div").attr("class", "picker-label").text("Relative importance sliders (normalized):");
    sliderPanel.append("div").attr("class", "chart-hint").style("margin", "0 0 4px 0")
        .text("Weights are normalized to sum to 1; only their ratios matter. Doubling all sliders has no effect.");
    Object.keys(pcaWeights).forEach(col => {
        let row = sliderPanel.append("div").attr("class", "weight-row");
        row.append("span").attr("class", "weight-label").text(label(col) + (directionOf(col) === "min" ? " (lower better)" : " (higher better)"));
        weightValueLabels[col] = row.append("span").attr("class", "weight-value");
        row.append("input")
            .attr("type", "range").attr("min", 0).attr("max", 1).attr("step", 0.05)
            .attr("value", pcaWeights[col])
            .on("input", function () { pcaWeights[col] = +this.value; renderChart3(); }); // redraw live as the slider moves
    });

    let loadingsPanel = chart3.append("div").attr("class", "pca-loadings-panel").attr("id", "pcaLoadingsPanel");

    // ---- mode buttons: Hover/click vs Lasso ----
    let modeBar = chart3.append("div").attr("class", "scatter-mode-bar");
    ["none", "lasso"].forEach(m => {
        modeBar.append("button")
            .attr("class", "mode-btn" + (pcaMode === m ? " active" : ""))
            .text(m === "none" ? "Hover / click to pin" : "Lasso")
            .attr("title", m === "none" ? "Hover a point for details, click to pin it" :
                "Draw a freehand lasso to cross-filter (click again to deactivate)")
            .on("click", () => {
                pcaMode = (pcaMode === m && m !== "none") ? "none" : m;
                createChart3();
            });
    });

    chart3.append("div").attr("class", "chart-export-row")
        .append("button").attr("class", "export-btn")
        .text("↓ Export PNG")
        .on("click", () => {
            if (!pcaCanvas) return;
            let svgEl = pcaCanvas.node().parentElement.querySelector('svg');
            if (svgEl) exportLayeredChart(svgEl, pcaCanvas.node(), "pca-map.png");
        });

    let wrapper = chart3.append("div")
        .attr("class", "pca-canvas-wrapper")
        .style("position", "relative")
        .style("width", pcaWidth + "px").style("height", pcaHeight + "px");

    pcaCanvas = wrapper.append("canvas")
        .attr("width", pcaWidth).attr("height", pcaHeight)
        .style("position", "absolute").style("top", 0).style("left", 0);
    pcaCtx = pcaCanvas.node().getContext("2d");

    pcaSvg = wrapper.append("svg")
        .attr("width", pcaWidth).attr("height", pcaHeight)
        .style("position", "absolute").style("top", 0).style("left", 0)
        .append("g");

    chart3.append("p").attr("class", "chart-hint")
        .text("Hover a point for its score · click to pin · Lasso selects a cluster and cross-filters all other charts.");

    renderChart3();
}

// ------------------------------------------------------------------
// pcaScales(): works out the x/y pixel scales for whichever PCA scope is
// active. Unlike a normal scatterplot, PCA axes need to keep the SAME
// pixel-to-unit ratio on both x and y (otherwise you'd visually distort
// the true "distances" between alloys, which is the whole point of the
// chart) - that's what all the "nice"/padding math below is doing.
// ------------------------------------------------------------------
function pcaScales() {
    let scope = pcaCurrentScope();
    let plotW = pcaWidth - pcaMargin.left - pcaMargin.right;
    let plotH = pcaHeight - pcaMargin.top - pcaMargin.bottom;

    // "nice" rounds the data's min/max out to friendlier round numbers for the axis
    let niceX = d3.scaleLinear().domain(d3.extent(alloyData, d => d[scope.pc1])).nice().domain();
    let niceY = d3.scaleLinear().domain(d3.extent(alloyData, d => d[scope.pc2])).nice().domain();
    let dataW = Math.max(niceX[1] - niceX[0], 1e-9);
    let dataH = Math.max(niceY[1] - niceY[0], 1e-9);

    // Use whichever axis is more "cramped" (fewer pixels per unit) for BOTH
    // axes, so a 1-unit step means the same physical distance in x and y
    let pxPerUnit = Math.min(plotW / dataW, plotH / dataH);
    let usedW = dataW * pxPerUnit, usedH = dataH * pxPerUnit;
    // Center the plot in the available space (any leftover width/height becomes padding)
    let xPad = (plotW - usedW) / 2, yPad = (plotH - usedH) / 2;

    let x = d3.scaleLinear().domain(niceX)
        .range([pcaMargin.left + xPad, pcaMargin.left + xPad + usedW]);
    let y = d3.scaleLinear().domain(niceY)
        .range([pcaHeight - pcaMargin.bottom - yPad, pcaMargin.top + yPad]);
    return { x, y };
}

// Shows the shared tooltip (from chart1-pcp.js) plus an extra line showing this alloy's weighted score
function showPcaTooltip(event, d) {
    showPcpTooltip(event, d);
    let scoreCols = Object.keys(pcaWeights).map(c => `${c} (w=${pcaWeights[c].toFixed(2)})`).join(", ");
    let tooltip = d3.select(".tooltip");
    tooltip.html(
        tooltip.html() +
        `<br/><b>Weighted score: ${d.__score.toFixed(3)}</b><br/><span style="font-size:.65rem;">from: ${scoreCols}</span>`
    );
}

// ------------------------------------------------------------------
// renderChart3(): (re)draws everything in chart 3 - called whenever a
// slider moves, the scope changes, a filter/pin changes, etc.
// ------------------------------------------------------------------
function renderChart3() {
    if (!pcaCtx) return;
    computeDirectedWeightedScore(alloyData, pcaWeights); // make sure every alloy's __score is up to date with the current sliders

    // Update the little numbers shown next to each slider (raw value + normalized %)
    let wSum = Object.values(pcaWeights).reduce((s, v) => s + v, 0) || 1;
    Object.keys(pcaWeights).forEach(col => {
        let pct = ((pcaWeights[col] / wSum) * 100).toFixed(0);
        weightValueLabels[col].text(`${pcaWeights[col].toFixed(2)} (${pct}%)`);
    });

    let { x, y } = pcaScales();
    let scoreExtent = getExtent("__score");
    if (!(scoreExtent[1] > scoreExtent[0])) {
        scoreExtent = [scoreExtent[0] - 0.5, scoreExtent[0] + 0.5]; // guard against every alloy having the exact same score
    }
    let colorScale = d3.scaleSequential(d3.interpolateViridis).domain(scoreExtent); // dark purple (low score) to bright yellow (high score)

    let scope = pcaCurrentScope();
    let activeSet = new Set(activeRows().map(d => d.__id));
    pcaCtx.clearRect(0, 0, pcaWidth, pcaHeight);
    // Draw every alloy as a tiny colored square, faded out if it's currently filtered out
    alloyData.forEach(d => {
        let px = x(d[scope.pc1]), py = y(d[scope.pc2]);
        pcaCtx.globalAlpha = activeSet.has(d.__id) ? 0.85 : 0.06;
        pcaCtx.fillStyle = colorScale(d.__score);
        pcaCtx.fillRect(px - 1.5, py - 1.5, 3, 3);
    });
    pcaCtx.globalAlpha = 1;

    // ---- Axes ----
    pcaSvg.selectAll(".pca-axis, .pca-axis-title").remove();
    pcaSvg.append("g").attr("class", "pca-axis")
        .attr("transform", `translate(0,${pcaHeight - pcaMargin.bottom})`).call(d3.axisBottom(x).ticks(5));
    pcaSvg.append("g").attr("class", "pca-axis")
        .attr("transform", `translate(${pcaMargin.left},0)`).call(d3.axisLeft(y).ticks(5));
    let scopeShortLabel = scope.label ? scope.label.split("(")[0].trim() : "";
    pcaSvg.append("text").attr("class", "pca-axis-title")
        .attr("x", pcaWidth / 2).attr("y", pcaHeight - 4).attr("text-anchor", "middle")
        .text("PC1 - " + scopeShortLabel);
    pcaSvg.append("text").attr("class", "pca-axis-title")
        .attr("transform", "rotate(-90)").attr("x", -pcaHeight / 2).attr("y", 12)
        .attr("text-anchor", "middle").text("PC2");

    // Small text explaining how much of the data's overall spread PC1/PC2 actually capture
    d3.select("#pcaVarianceLabel").html(
        `<b>${scope.label}</b> - ` +
        `PC1 explains ${(scope.ve[0] * 100).toFixed(1)}% of variance, ` +
        `PC2 explains ${(scope.ve[1] * 100).toFixed(1)}%.`
    );

    // ---- Color gradient legend (poor -> excellent) ----
    pcaSvg.selectAll(".pca-legend, defs").remove();
    let legendWidth = 150, legendHeight = 10;
    let gradId = "pcaScoreGradient";
    let gradient = pcaSvg.append("defs").append("linearGradient").attr("id", gradId).attr("x1", "0%").attr("x2", "100%");
    d3.range(0, 1.01, 0.1).forEach(t => {
        gradient.append("stop").attr("offset", (t * 100) + "%").attr("stop-color", d3.interpolateViridis(t));
    });
    let legend = pcaSvg.append("g").attr("class", "pca-legend")
        .attr("transform", `translate(${pcaWidth - pcaMargin.right - legendWidth}, ${pcaMargin.top - 16})`);
    legend.append("rect").attr("width", legendWidth).attr("height", legendHeight)
        .attr("fill", `url(#${gradId})`).attr("stroke", "#999").attr("stroke-width", 0.5);
    legend.append("text").attr("class", "pca-legend-title")
        .attr("x", legendWidth / 2).attr("y", -4).attr("text-anchor", "middle").text("weighted score");
    legend.append("text").attr("class", "pca-legend-label")
        .attr("x", 0).attr("y", legendHeight + 11).text(`poor (${scoreExtent[0].toFixed(2)})`);
    legend.append("text").attr("class", "pca-legend-label")
        .attr("x", legendWidth).attr("y", legendHeight + 11).attr("text-anchor", "end").text(`excellent (${scoreExtent[1].toFixed(2)})`);

    // ---- Pinned alloys: draw a hollow blue ring around each one so they stand out ----
    let pinnedDots = pcaSvg.selectAll(".pca-pin").data(alloyData.filter(d => pinnedIds.includes(d.__id)), d => d.__id);
    pinnedDots.exit().remove();
    pinnedDots.enter().append("circle").attr("class", "pca-pin")
        .merge(pinnedDots)
        .attr("cx", d => x(d[scope.pc1])).attr("cy", d => y(d[scope.pc2]))
        .attr("r", 6).attr("fill", "none").attr("stroke", COLOR_PINNED).attr("stroke-width", 2);

    // Clear old brush/lasso layers + mouse handlers before setting up the ones for the current mode
    pcaSvg.selectAll(".pca-lasso-layer").remove();
    pcaCanvas.on("mousemove", null).on("mouseleave", null).on("click", null).style("cursor", "default");

    if (pcaMode === "lasso") {
        // ---- Lasso mode: same idea as chart2-scatter.js's lasso - draw a
        // freehand shape, then cross-filter to whatever alloys fall inside it ----
        pcaSvg.append("rect").attr("class", "pca-lasso-layer")
            .attr("x", 0).attr("y", 0).attr("width", pcaWidth).attr("height", pcaHeight)
            .attr("fill", "transparent").style("cursor", "crosshair")
            .call(d3.drag()
                .on("start", () => { pcaLassoPoints = []; })
                .on("drag", (event) => {
                    pcaLassoPoints.push([event.x, event.y]);
                    if (!pcaLassoPath) pcaLassoPath = pcaSvg.append("path").attr("class", "lasso-path");
                    pcaLassoPath.attr("d", "M" + pcaLassoPoints.map(p => p.join(",")).join("L") + "Z")
                        .attr("fill", "rgba(38,70,83,0.12)").attr("stroke", "#264653").attr("stroke-dasharray", "4,3");
                })
                .on("end", () => {
                    if (pcaLassoPoints.length > 2) {
                        let matches = alloyData.filter(d =>
                            passesPcpFilters(d) &&
                            d3.polygonContains(pcaLassoPoints, [x(d[scope.pc1]), y(d[scope.pc2])])
                        );
                        lastPcaMatches = matches;
                        setExternalHighlight(matches, "PCA lasso");
                    }
                    if (pcaLassoPath) { pcaLassoPath.remove(); pcaLassoPath = null; }
                })
            );
    } else {
        // ---- Hover/click mode: find the nearest alloy to the mouse using a quadtree (fast nearest-point lookup) ----
        let quadtree = d3.quadtree().x(d => x(d[scope.pc1])).y(d => y(d[scope.pc2])).addAll(alloyData);

        pcaCanvas
            .style("cursor", "pointer")
            .on("mousemove", function (event) {
                let [mx, my] = d3.pointer(event, this);
                let nearest = quadtree.find(mx, my, PCA_HOVER_RADIUS);
                if (nearest) { showPcaTooltip(event, nearest); setHovered(nearest.__id); }
                else { hidePcpTooltip(); clearHovered(); }
            })
            .on("mouseleave", () => { hidePcpTooltip(); clearHovered(); })
            .on("click", function (event) {
                let [mx, my] = d3.pointer(event, this);
                let nearest = quadtree.find(mx, my, PCA_HOVER_RADIUS);
                if (nearest) togglePin(nearest.__id);
            });
    }

    renderPcaLoadings(); // update the "top 5 drivers" bar list under the chart
}

// Draws a small orange highlight ring around whichever alloy is currently
// hovered in ANY chart (part of the cross-chart hover system)
function renderPcaHoverDot() {
    if (!pcaSvg) return;
    pcaSvg.selectAll(".pca-hover-dot").remove();
    if (!hoveredId) return;
    let d = alloyById.get(hoveredId);
    if (!d) return;
    let scope = pcaCurrentScope();
    let { x, y } = pcaScales();
    pcaSvg.append("circle").attr("class", "pca-hover-dot")
        .attr("cx", x(d[scope.pc1])).attr("cy", y(d[scope.pc2]))
        .attr("r", 7).attr("fill", "rgba(255,107,53,0.15)").attr("stroke", "#ff6b35")
        .attr("stroke-width", 2.5).attr("pointer-events", "none");
}

// ------------------------------------------------------------------
// renderPcaLoadings(): fills in the little panel below the chart showing,
// for both PC1 and PC2, which 5 original columns influence that axis the
// most (as horizontal bars - blue if that column pulls the axis one way,
// red if it pulls the opposite way). This helps answer "ok, PC1 is high...
// but WHAT DOES THAT MEAN in terms of real properties?"
// ------------------------------------------------------------------
function renderPcaLoadings() {
    let panel = d3.select("#pcaLoadingsPanel");
    if (panel.empty()) return;
    panel.html("");

    let scope = pcaCurrentScope();
    if (!scope || !scope.loadings || !scope.loadings.pc1.length) return;

    let pct1 = (scope.ve[0] * 100).toFixed(1);
    let pct2 = (scope.ve[1] * 100).toFixed(1);

    ["pc1", "pc2"].forEach((pc, idx) => {
        let varPct = idx === 0 ? pct1 : pct2;
        panel.append("h5").text(`${pc.toUpperCase()} (${varPct}% var.) ; top 5 drivers:`);
        let top5 = scope.loadings[pc].slice(0, 5);
        let maxAbs = Math.max(...top5.map(d => Math.abs(d.loading)), 0.01);
        top5.forEach(({ col, loading }) => {
            let row = panel.append("div").attr("class", "loadings-row");
            row.append("span").attr("class", "loadings-col-name").attr("title", label(col)).text(label(col));
            let barWrap = row.append("div").attr("class", "loadings-bar-wrap");
            barWrap.append("div").attr("class", "loadings-bar")
                .style("width", (Math.abs(loading) / maxAbs * 100) + "%")
                .style("background", loading >= 0 ? "#2563eb" : "#dc2626"); // blue if positive influence, red if negative
            row.append("span").attr("class", "loadings-val")
                .text((loading >= 0 ? "+" : "") + loading.toFixed(3));
        });
    });
}
