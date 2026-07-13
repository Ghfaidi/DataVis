// Group 05 · Meriam Ferjani, Ghofrane Faidi

/*

This file builds Chart 2: a normal x/y Scatterplot, but with some extra
power features:
  - You choose which column goes on x and which goes on y (dropdowns)
  - It draws a soft "density cloud" behind the dots, so you can tell where
    most alloys cluster even with thousands of points
  - It draws the Pareto front as a stepped amber line + dots (the
    "best trade-off" alloys for whichever 2 columns you picked - see
    paretoFront2D in stats.js for how that's computed)
  - 3 interaction modes you can switch between with the buttons:
      "Hover only" - just hover to inspect, click a point to pin it
      "Target zone" - drag a rectangle to cross-filter every other chart
      "Lasso"       - draw a freehand loop to cross-filter every other chart

Just like chart1-pcp.js, the actual dots are drawn on a <canvas> (fast, for
potentially thousands of points) while the axes, Pareto line/dots, and
brush/lasso interactions are drawn as SVG on top (since there are few of them).
*/

// PROPERTY_DIRECTION says, for each column, whether a HIGHER or LOWER
// value counts as "better" - used to decide which way the Pareto front
// arrow points, and to show "(higher → better)" hints next to axis labels.
const PROPERTY_DIRECTION = {
    [COLUMNS.ys]: "max",
    [COLUMNS.csc]: "min",
    [COLUMNS.hardness]: "max",
    [COLUMNS.density]: "min",
    [COLUMNS.thermCond]: "max",
    "delta_T":           "min",
    "delta_T_FCC":       "min",
    "delta_T_Al15Si2M4": "min",
    "delta_T_Si":        "min",
    "eut. frac.[%]":     "max",
    "CTEvol(1/K)(20.0-300.0°C)":                     "min",
    "Volume(m3/mol)":                                  "min",
    "El.conductivity(S/m)":                            "max",
    "El. resistivity(ohm m)":                          "min",
    "heat capacity(J/(mol K))":                        "max",
    "Therm. diffusivity(m2/s)":                        "max",
    "Therm.resistivity(mK/W)":                         "min",
    "Linear thermal expansion (1/K)(20.0-300.0°C)":    "min",
    "Technical thermal expansion (1/K)(20.0-300.0°C)": "min"
};
// Falls back to "max" if we don't have an explicit direction for a column
function directionOf(col) { return PROPERTY_DIRECTION[col] || "max"; }

const SCATTER_HOVER_RADIUS = 8; // how many pixels away the mouse can be from a dot and still "hover" it

let scatterAxes = { x: COLUMNS.ys, y: COLUMNS.csc }; // which columns are currently on the x/y axis

let scatterMode = "none"; // "none" (hover/click), "target" (rectangle brush), or "lasso" (freehand)
let scatterWidth = 420, scatterHeight = 420;
let scatterMargin = { top: 20, right: 20, bottom: 40, left: 55 };
let scatterCanvas, scatterCtx, scatterSvg;
let lassoPoints = [];      // the points the user has dragged through while drawing a lasso
let lassoPath;
let lastMatches = [];       // the alloys that matched the last target-zone/lasso selection
let lastTargetZone = null;  // remembers the last rectangle drawn, so it can be redrawn after a re-render
let suppressScatterBrushEvents = false; // avoids a feedback loop when we move the brush programmatically
let paretoFrontCache = null; // cached Pareto front result, recomputed only when something relevant changes

// ------------------------------------------------------------------
// createChart2(): builds chart 2's controls (axis dropdowns, mode
// buttons) and its canvas/svg drawing area from scratch.
// ------------------------------------------------------------------
function createChart2() {
    chart2.selectAll("*").remove();
    paretoFrontCache = null;
    lastTargetZone = null;

    // Work out how big to draw the chart based on its card's actual size on screen (kept square)
    let _cw = chart2.node() ? chart2.node().clientWidth - 4 : 420;
    scatterWidth = Math.max(300, Math.min(720, _cw));
    scatterHeight = scatterWidth;
    scatterMargin = { top: 20, right: 20, bottom: 40, left: scatterWidth < 380 ? 44 : 55 };

    let controls = chart2.append("div").attr("class", "scatter-controls");

    // Helper that fills one <select> dropdown with all the pickable
    // columns, grouped into the same 5 categories used elsewhere
    function buildAxisSelect(sel, includeNone, selectedValue) {
        if (includeNone) sel.append("option").attr("value", "").text("— none —");
        const AXIS_GROUPS = [
            { label: "Mechanical Properties",     cols: MECHANICAL_AXES },
            { label: "Thermophysical Properties", cols: THERMOPHYSICAL_AXES },
            { label: "Microstructure",            cols: MICROSTRUCTURE_AXES },
            { label: "Inputs",                    cols: COLUMNS.inputs },
            { label: "Chemical Composition",      cols: COLUMNS.chemistry }
        ];
        AXIS_GROUPS.forEach(g => {
            let og = sel.append("optgroup").attr("label", g.label);
            og.selectAll("option").data(g.cols).enter().append("option")
                .attr("value", d => d)
                .property("selected", d => d === selectedValue)
                .text(d => label(d));
        });
    }

    // ---- x axis dropdown ----
    controls.append("label").text("x: ");
    let xSel = controls.append("select").attr("class", "scatter-x-select");
    buildAxisSelect(xSel, false, scatterAxes.x);
    xSel.on("change", function () {
        let newX = this.value;
        // If you pick the same column already used for y, swap them
        // instead of leaving both axes showing the same thing
        if (newX === scatterAxes.y) {
            scatterAxes.y = scatterAxes.x;
            ySel.property("value", scatterAxes.y);
        }
        scatterAxes.x = newX;
        renderChart2();
        saveState();
    });

    // ---- swap button: flips x and y ----
    let swapBtn = controls.append("button").attr("class", "swap-axes-btn").html("⇆")
        .attr("title", "Swap x and y axes")
        .on("click", () => {
            [scatterAxes.x, scatterAxes.y] = [scatterAxes.y, scatterAxes.x];
            xSel.property("value", scatterAxes.x);
            ySel.property("value", scatterAxes.y);
            renderChart2();
        });

    // ---- y axis dropdown ----
    controls.append("label").text("y: ");
    let ySel = controls.append("select").attr("class", "scatter-y-select");
    buildAxisSelect(ySel, false, scatterAxes.y);
    ySel.on("change", function () {
        let newY = this.value;
        if (newY === scatterAxes.x) {
            scatterAxes.x = scatterAxes.y;
            xSel.property("value", scatterAxes.x);
        }
        scatterAxes.y = newY;
        renderChart2();
        saveState();
    });

    // ---- interaction mode buttons: Hover only / Target zone / Lasso ----
    let modeBar = chart2.append("div").attr("class", "scatter-mode-bar");
    ["none", "target", "lasso"].forEach(m => {
        modeBar.append("button")
            .attr("class", "mode-btn" + (scatterMode === m ? " active" : ""))
            .text(m === "none" ? "Hover only" : m === "target" ? "Target zone" : "Lasso")
            .attr("title", m === "none" ? "Hover to inspect, click to pin" :
                           m === "target" ? "Draw a rectangle to cross-filter (click again to deactivate)" :
                           "Draw a freehand lasso to cross-filter (click again to deactivate)")
            .on("click", () => {
                // Clicking the already-active mode turns it back off ("none"); otherwise switch to it
                scatterMode = (scatterMode === m && m !== "none") ? "none" : m;
                createChart2(); // full rebuild so the button highlight + hint text stay in sync
            });
    });

    // ---- the drawing area: canvas (dots) + svg (axes/pareto/brush) stacked on top of each other ----
    let wrapper = chart2.append("div")
        .attr("class", "scatter-canvas-wrapper")
        .style("position", "relative")
        .style("width", scatterWidth + "px")
        .style("height", scatterHeight + "px");

    scatterCanvas = wrapper.append("canvas")
        .attr("width", scatterWidth).attr("height", scatterHeight)
        .style("position", "absolute").style("top", 0).style("left", 0);
    scatterCtx = scatterCanvas.node().getContext("2d");

    scatterSvg = wrapper.append("svg")
        .attr("width", scatterWidth).attr("height", scatterHeight)
        .style("position", "absolute").style("top", 0).style("left", 0)
        .append("g");

    chart2.append("div").attr("class", "chart-export-row")
        .append("button").attr("class", "export-btn")
        .text("↓ Export PNG")
        .on("click", () => {
            if (!scatterCanvas) return;
            let svgEl = scatterCanvas.node().parentElement.querySelector('svg');
            if (svgEl) exportLayeredChart(svgEl, scatterCanvas.node(), "scatterplot.png");
        });

    chart2.append("p").attr("class", "chart-hint")
        .text("Hover a point for details · click to pin (max 3) · use Target zone or Lasso to cross-filter all other charts. Amber = Pareto-optimal for the chosen axes.");

    renderChart2();
}

// The x/y pixel scales for whichever 2 columns are currently chosen
function scatterScales() {
    let x = d3.scaleLinear()
        .domain(getExtent(scatterAxes.x)).nice()
        .range([scatterMargin.left, scatterWidth - scatterMargin.right]);
    let y = d3.scaleLinear()
        .domain(getExtent(scatterAxes.y)).nice()
        .range([scatterHeight - scatterMargin.bottom, scatterMargin.top]);
    return { x, y };
}

// ------------------------------------------------------------------
// getParetoFrontCached(): computing the Pareto front means sorting and
// scanning every active row, which we don't want to redo on every single
// redraw if nothing relevant actually changed. This remembers the last
// result and only recomputes when the chosen axes or the active filters
// have changed since last time (tracked via the `key` string).
// ------------------------------------------------------------------
function getParetoFrontCached() {
    let rows = activeRows();
    let key = scatterAxes.x + ">" + scatterAxes.y + ">" + filterVersion;
    if (paretoFrontCache && paretoFrontCache.key === key) return paretoFrontCache;

    let dirX = directionOf(scatterAxes.x), dirY = directionOf(scatterAxes.y);
    let frontSet = paretoFront2D(rows, scatterAxes.x, dirX, scatterAxes.y, dirY);
    let frontPoints = [...frontSet].map(i => rows[i])
        .sort((a, b) => (dirX === "max" ? 1 : -1) * (a[scatterAxes.x] - b[scatterAxes.x]));

    paretoFrontCache = { key, frontSet, frontPoints };
    return paretoFrontCache;
}

// ------------------------------------------------------------------
// renderChart2(): (re)draws everything in chart 2 - called whenever the
// chosen axes, filters, pins, or interaction mode change.
// ------------------------------------------------------------------
function renderChart2() {
    if (!scatterCtx) return;

    let subtitle = d3.select("#chart2Subtitle");
    let { x, y } = scatterScales();
    let activeSet = new Set(activeRows().map(d => d.__id));

    // Update the small subtitle text under the chart title, e.g.
    // "Yield Strength (higher → better) vs. Hot-Crack Susceptibility (lower → better) — 120 / 500 active"
    let countNote = activeSet.size < alloyData.length
        ? ` — ${activeSet.size.toLocaleString()} / ${alloyData.length.toLocaleString()} active` : "";
    if (!subtitle.empty()) {
        let xLbl2 = label(scatterAxes.x), yLbl2 = label(scatterAxes.y);
        let xDir2 = PROPERTY_DIRECTION[scatterAxes.x], yDir2 = PROPERTY_DIRECTION[scatterAxes.y];
        let xHint2 = xDir2 === "max" ? " (higher → better)" : xDir2 === "min" ? " (lower → better)" : "";
        let yHint2 = yDir2 === "max" ? " (higher → better)" : yDir2 === "min" ? " (lower → better)" : "";
        subtitle.text(`${xLbl2}${xHint2} vs. ${yLbl2}${yHint2}${countNote}`);
    }

    scatterCtx.clearRect(0, 0, scatterWidth, scatterHeight);

    // ---- Density cloud: a faint purple "heatmap" behind the dots showing
    // where points cluster most densely, even once there are too many dots
    // to see individually. We divide the plot into a 40x40 grid of cells,
    // count how many alloys fall in each cell, then shade each cell based
    // on that count (using log scaling so a few very dense cells don't
    // wash out all the others). ----
    const DBINS = 40;
    let pLeft = scatterMargin.left, pTop = scatterMargin.top;
    let pW = scatterWidth - scatterMargin.left - scatterMargin.right;
    let pH = scatterHeight - scatterMargin.top - scatterMargin.bottom;
    let dW = pW / DBINS, dH = pH / DBINS;
    let densGrid = new Uint16Array(DBINS * DBINS);
    alloyData.forEach(d => {
        let px = x(d[scatterAxes.x]), py = y(d[scatterAxes.y]);
        let gi = Math.min(DBINS - 1, Math.max(0, Math.floor((px - pLeft) / dW)));
        let gj = Math.min(DBINS - 1, Math.max(0, Math.floor((py - pTop) / dH)));
        densGrid[gj * DBINS + gi]++;
    });
    let maxDens = Math.max(...densGrid, 1);
    for (let gj = 0; gj < DBINS; gj++) {
        for (let gi = 0; gi < DBINS; gi++) {
            let c = densGrid[gj * DBINS + gi];
            if (c === 0) continue;
            let alpha = 0.14 * Math.log1p(c) / Math.log1p(maxDens);
            scatterCtx.fillStyle = `rgba(99,102,241,${alpha.toFixed(3)})`;
            scatterCtx.fillRect(pLeft + gi * dW, pTop + gj * dH, dW, dH);
        }
    }

    // ---- The actual dots: tiny 2x2 pixel squares (cheaper to draw than
    // circles when there could be thousands), brighter if "active" (passes filters) ----
    alloyData.forEach(d => {
        let px = x(d[scatterAxes.x]), py = y(d[scatterAxes.y]);
        scatterCtx.fillStyle = activeSet.has(d.__id) ? "rgba(60,70,80,0.16)" : "rgba(60,70,80,0.03)";
        scatterCtx.fillRect(px - 1, py - 1, 2, 2);
    });

    // ---- Axes ----
    scatterSvg.selectAll(".scatter-axis").remove();
    scatterSvg.append("g").attr("class", "scatter-axis")
        .attr("transform", `translate(0,${scatterHeight - scatterMargin.bottom})`)
        .call(d3.axisBottom(x).ticks(6));
    scatterSvg.append("g").attr("class", "scatter-axis")
        .attr("transform", `translate(${scatterMargin.left},0)`)
        .call(d3.axisLeft(y).ticks(6));
    let xDir = directionOf(scatterAxes.x);
    let yDir = directionOf(scatterAxes.y);
    scatterSvg.append("text").attr("class", "scatter-axis-title")
        .attr("x", scatterWidth / 2).attr("y", scatterHeight - 4)
        .attr("text-anchor", "middle")
        .text(label(scatterAxes.x) + (xDir === "max" ? "  → better" : "  ← better"));
    scatterSvg.append("text").attr("class", "scatter-axis-title")
        .attr("transform", "rotate(-90)")
        .attr("x", -scatterHeight / 2).attr("y", 14)
        .attr("text-anchor", "middle")
        .text(label(scatterAxes.y) + (yDir === "max" ? "  ↑ better" : "  ↓ better"));

    // ---- Pareto front: a stepped line connecting the "best trade-off" alloys, plus a dot on each one ----
    let { frontPoints } = getParetoFrontCached();

    let stepLine = d3.line()
        .x(d => x(d[scatterAxes.x]))
        .y(d => y(d[scatterAxes.y]))
        .curve(d3.curveStepAfter); // draws right-angle "staircase" steps instead of a straight/curvy line

    scatterSvg.selectAll(".pareto-step").remove();
    scatterSvg.append("path")
        .attr("class", "pareto-step")
        .attr("d", stepLine(frontPoints))
        .attr("fill", "none")
        .attr("stroke", COLOR_PARETO)
        .attr("stroke-width", 2);

    let frontDots = scatterSvg.selectAll(".pareto-point").data(frontPoints, d => d.__id);
    frontDots.exit().remove();
    frontDots.enter().append("circle").attr("class", "pareto-point")
        .merge(frontDots)
        .attr("cx", d => x(d[scatterAxes.x]))
        .attr("cy", d => y(d[scatterAxes.y]))
        .attr("r", d => pinnedIds.includes(d.__id) ? 5 : 3) // pinned points get drawn bigger
        .attr("fill", d => pinnedIds.includes(d.__id) ? COLOR_PINNED : COLOR_PARETO)
        .attr("stroke", "#fff").attr("stroke-width", 1)
        .style("cursor", "pointer")
        .on("click", (event, d) => togglePin(d.__id))
        .on("mouseover", (event, d) => showPcpTooltip(event, d)) // reuses the shared tooltip function from chart1-pcp.js
        .on("mouseout", hidePcpTooltip);

    // Clear out any leftover brush/lasso layer + mouse handlers before re-adding the ones for the current mode
    scatterSvg.selectAll(".scatter-brush, .lasso-layer").remove();
    scatterCanvas.on("mousemove", null).on("mouseleave", null).on("click", null).style("cursor", "default");

    if (scatterMode === "target") {
        // ---- Target-zone mode: drag out a rectangle; anything inside it
        // becomes the new cross-filter highlight for every chart ----
        let brush = d3.brush()
            .extent([[scatterMargin.left, scatterMargin.top], [scatterWidth - scatterMargin.right, scatterHeight - scatterMargin.bottom]])
            .on("end", (event) => {
                if (suppressScatterBrushEvents) return;
                if (!event.selection) { lastMatches = []; lastTargetZone = null; clearExternalHighlight(); return; }
                let [[x0, y0], [x1, y1]] = event.selection;
                let xMin = x.invert(x0), xMax = x.invert(x1);
                let yMin = y.invert(y1), yMax = y.invert(y0);
                lastTargetZone = { colX: scatterAxes.x, colY: scatterAxes.y, xMin, xMax, yMin, yMax };

                let matches = alloyData.filter(d =>
                    passesPcpFilters(d) &&
                    d[scatterAxes.x] >= xMin && d[scatterAxes.x] <= xMax &&
                    d[scatterAxes.y] >= yMin && d[scatterAxes.y] <= yMax
                );
                lastMatches = matches;

                setExternalHighlight(matches, "Scatterplot target zone");
            });
        let brushGroup = scatterSvg.append("g").attr("class", "scatter-brush").call(brush);

        // If a target zone was already drawn for these SAME 2 axes, redraw
        // its rectangle in the right spot (without re-triggering the "end" handler above)
        if (lastTargetZone && lastTargetZone.colX === scatterAxes.x && lastTargetZone.colY === scatterAxes.y) {
            let { xMin, xMax, yMin, yMax } = lastTargetZone;
            let px0 = x(xMin), px1 = x(xMax);
            let py0 = y(yMax), py1 = y(yMin);
            suppressScatterBrushEvents = true;
            brush.move(brushGroup, [[Math.min(px0, px1), Math.min(py0, py1)], [Math.max(px0, px1), Math.max(py0, py1)]]);
            suppressScatterBrushEvents = false;
        }
    } else if (scatterMode === "lasso") {
        // ---- Lasso mode: draw a freehand shape by dragging the mouse; any
        // alloy whose dot ends up inside that shape becomes the new cross-filter ----
        scatterSvg.append("rect").attr("class", "lasso-layer")
            .attr("x", 0).attr("y", 0).attr("width", scatterWidth).attr("height", scatterHeight)
            .attr("fill", "transparent")
            .style("cursor", "crosshair")
            .call(d3.drag()
                .on("start", () => { lassoPoints = []; })
                .on("drag", (event) => {
                    lassoPoints.push([event.x, event.y]); // record every point the mouse passes through
                    if (!lassoPath) lassoPath = scatterSvg.append("path").attr("class", "lasso-path");
                    lassoPath.attr("d", "M" + lassoPoints.map(p => p.join(",")).join("L") + "Z") // draw the shape so far, closing the loop
                        .attr("fill", "rgba(232,163,61,0.15)")
                        .attr("stroke", "#e8a33d").attr("stroke-dasharray", "4,3");
                })
                .on("end", () => {
                    if (lassoPoints.length > 2) {
                        // d3.polygonContains checks whether a given (x,y) point is inside the drawn shape
                        let matches = alloyData.filter(d =>
                            passesPcpFilters(d) &&
                            d3.polygonContains(lassoPoints, [x(d[scatterAxes.x]), y(d[scatterAxes.y])])
                        );
                        lastMatches = matches;
                        setExternalHighlight(matches, "Scatterplot lasso");
                    }
                    if (lassoPath) { lassoPath.remove(); lassoPath = null; } // remove the temporary drawing once we're done
                })
            );
    } else {
        // ---- "Hover only" mode: just find the nearest dot to the mouse
        // (using a quadtree - a fast structure for "what's near this point?"
        // lookups) so we can show a tooltip / let the user click to pin ----
        let quadtree = d3.quadtree()
            .x(d => x(d[scatterAxes.x]))
            .y(d => y(d[scatterAxes.y]))
            .addAll(alloyData);

        scatterCanvas
            .style("cursor", "pointer")
            .on("mousemove", function (event) {
                let [mx, my] = d3.pointer(event, this);
                let nearest = quadtree.find(mx, my, SCATTER_HOVER_RADIUS);
                if (nearest) { showPcpTooltip(event, nearest); setHovered(nearest.__id); }
                else { hidePcpTooltip(); clearHovered(); }
            })
            .on("mouseleave", () => { hidePcpTooltip(); clearHovered(); })
            .on("click", function (event) {
                let [mx, my] = d3.pointer(event, this);
                let nearest = quadtree.find(mx, my, SCATTER_HOVER_RADIUS);
                if (nearest) togglePin(nearest.__id);
            });
    }
}

// Draws a small orange ring around whichever alloy is currently hovered in
// ANY chart (part of the cross-chart hover-highlight system, see setHovered in dashboard.js)
function renderScatterHoverDot() {
    if (!scatterSvg) return;
    scatterSvg.selectAll(".scatter-hover-dot").remove();
    if (!hoveredId) return;
    let d = alloyById.get(hoveredId);
    if (!d) return;
    let { x, y } = scatterScales();
    scatterSvg.append("circle").attr("class", "scatter-hover-dot")
        .attr("cx", x(d[scatterAxes.x])).attr("cy", y(d[scatterAxes.y]))
        .attr("r", 7).attr("fill", "rgba(255,107,53,0.15)").attr("stroke", "#ff6b35")
        .attr("stroke-width", 2.5).attr("pointer-events", "none");
}
